/*
 * =========================================================
 * GPTExport - content.ts
 * =========================================================
 *
 * The content script:
 *
 * 1. Injects pageBridge.js into ChatGPT's MAIN world.
 * 2. Requests conversation pages from the bridge.
 * 3. Paginates backwards through the ChatGPT conversation API.
 * 4. Converts API messages into the format expected by popup.ts.
 *
 * No DOM scrolling is used.
 * No conversation credentials are stored by this file.
 */

/*
 * ---------------------------------------------------------
 * PAGE BRIDGE INJECTION
 * ---------------------------------------------------------
 */

function injectPageBridge(): void {
  if (document.documentElement.dataset.gptExportBridgeInjected === "true") {
    return;
  }

  const script = document.createElement("script");

  script.src = chrome.runtime.getURL("pageBridge.js");

  script.dataset.gptExport = "page-bridge";

  script.onload = () => {
    script.remove();

    console.log("GPTExport: page bridge injected");
  };

  script.onerror = () => {
    console.error("GPTExport: failed to inject page bridge");
  };

  (document.head || document.documentElement).appendChild(script);

  document.documentElement.dataset.gptExportBridgeInjected = "true";
}

injectPageBridge();

/*
 * ---------------------------------------------------------
 * EXPORT MESSAGE TYPE
 * ---------------------------------------------------------
 */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  order: number;
}

/*
 * ---------------------------------------------------------
 * CHATGPT API TYPES
 * ---------------------------------------------------------
 */

interface ApiMessage {
  id?: string;

  message?: ApiMessage | null;

  parent?: string | null;

  parent_message_id?: string | null;

  parent_id?: string | null;

  children?: string[];

  author?: {
    role?: string;
  };

  create_time?: number | null;

  content?: {
    content_type?: string;
    parts?: unknown[];
  };

  status?: string;

  end_turn?: boolean | null;

  recipient?: string | null;

  channel?: string | null;

  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    parent_id?: string | null;
    parent_message_id?: string | null;
    request_id?: string | null;
    turn_exchange_id?: string | null;
    [key: string]: unknown;
  };
}

interface ApiMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ApiMessage | null;
}

interface ConversationPage {
  messages?: ApiMessage[];

  mapping?: Record<string, ApiMappingNode>;

  current_node?: string | null;

  page_info?: {
    start_cursor?: string | null;
    end_cursor?: string | null;
    has_previous_page?: boolean;
    has_next_page?: boolean;
  };
}

function normalizeConversationPage(page: ConversationPage): ConversationPage {
  if (page.mapping) {
    const messages: ApiMessage[] = [];

    for (const [nodeId, node] of Object.entries(page.mapping)) {
      if (!node.message) {
        messages.push({
          id: nodeId,
          parent: node.parent,
          children: node.children,
        });
        continue;
      }

      messages.push({
        ...node.message,
        id: node.message.id ?? nodeId,
        parent: node.parent ?? node.message.parent,
        children: node.children ?? node.message.children,
      });
    }

    return {
      ...page,
      messages,
    };
  }

  const nestedMessages = page.messages?.filter(
    (message) => message.message !== null && message.message !== undefined,
  );

  if (!nestedMessages || nestedMessages.length === 0) {
    return page;
  }

  const messages: ApiMessage[] = [];

  for (const rawNode of page.messages ?? []) {
    const node = rawNode as ApiMappingNode;
    messages.push({
      ...(node.message ?? {}),
      id: node.message?.id ?? node.id ?? rawNode.id,
      parent: node.parent ?? node.message?.parent,
      children: node.children ?? node.message?.children,
    });
  }

  return {
    ...page,
    messages,
  };
}

function getApiMessageParentId(message: ApiMessage): string | null {
  const candidates = [
    message.parent,
    message.parent_message_id,
    message.parent_id,
    message.metadata?.parent_message_id,
    message.metadata?.parent_id,
  ];

  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  ) ?? null;
}

function getTurnExchangeId(message: ApiMessage): string | null {
  const value = message.metadata?.turn_exchange_id;

  return typeof value === "string" && value.length > 0 ? value : null;
}

function getApiMessageTime(message: ApiMessage): number {
  return message.create_time ?? Number.MAX_SAFE_INTEGER;
}

function resolveActiveMessages(
  rawById: Map<string, ApiMessage>,
  collected: Map<string, ApiMessage>,
  currentNode: string | null,
): ApiMessage[] {
  const exportable = Array.from(collected.values());
  const turnGroups = new Map<
    string,
    { user?: ApiMessage; assistant?: ApiMessage }
  >();

  for (const message of exportable) {
    const turnId = getTurnExchangeId(message);

    if (!turnId) {
      continue;
    }

    const group = turnGroups.get(turnId) ?? {};

    if (message.author?.role === "user") {
      group.user = message;
    } else if (message.author?.role === "assistant") {
      group.assistant = message;
    }

    turnGroups.set(turnId, group);
  }

  const completeTurns = Array.from(turnGroups.values()).filter(
    (turn): turn is { user: ApiMessage; assistant: ApiMessage } =>
      Boolean(turn.user && turn.assistant),
  );

  if (completeTurns.length > 0) {
    completeTurns.sort(
      (a, b) => getApiMessageTime(a.assistant) - getApiMessageTime(b.assistant),
    );

    return completeTurns.flatMap(({ user, assistant }) => [user, assistant]);
  }

  const users = exportable
    .filter((message) => message.author?.role === "user")
    .sort((a, b) => getApiMessageTime(a) - getApiMessageTime(b));
  const assistants = exportable
    .filter((message) => message.author?.role === "assistant")
    .sort((a, b) => getApiMessageTime(a) - getApiMessageTime(b));

  const assistantsByParent = new Map<string, ApiMessage[]>();

  for (const message of exportable) {
    if (message.author?.role !== "assistant") {
      continue;
    }

    const parentId = getApiMessageParentId(message);

    if (!parentId) {
      continue;
    }

    const assistants = assistantsByParent.get(parentId) ?? [];
    assistants.push(message);
    assistantsByParent.set(parentId, assistants);
  }

  const currentAssistant = currentNode ? rawById.get(currentNode) : undefined;
  const currentUserId = currentAssistant
    ? getApiMessageParentId(currentAssistant)
    : null;
  const usedAssistants = new Set<string>();
  const turns: Array<{
    user: ApiMessage;
    assistant?: ApiMessage;
    order: number;
  }> = [];

  for (const [userIndex, user] of users.entries()) {
    if (!user.id) {
      continue;
    }

    const candidates = assistantsByParent.get(user.id) ?? [];
    const mappedAssistant =
      user.id === currentUserId
        ? currentAssistant
        : candidates.sort(
            (a, b) => getApiMessageTime(b) - getApiMessageTime(a),
          )[0];
    const nextUserTime =
      users[userIndex + 1] === undefined
        ? Number.POSITIVE_INFINITY
        : getApiMessageTime(users[userIndex + 1]);
    const chronologicalAssistant = assistants.find((assistant) => {
      if (!assistant.id || usedAssistants.has(assistant.id)) {
        return false;
      }

      const assistantTime = getApiMessageTime(assistant);

      return (
        assistantTime >= getApiMessageTime(user) &&
        assistantTime < nextUserTime
      );
    });
    const nearestAssistant = assistants.find((assistant) => {
      if (!assistant.id || usedAssistants.has(assistant.id)) {
        return false;
      }

      return getApiMessageTime(assistant) >= getApiMessageTime(user);
    });
    const assistant = mappedAssistant ?? chronologicalAssistant ?? nearestAssistant;

    const selectedAssistant =
      assistant &&
      assistant.id &&
      !usedAssistants.has(assistant.id) &&
      isExportableApiMessage(assistant)
        ? assistant
        : undefined;

    if (selectedAssistant?.id) {
      usedAssistants.add(selectedAssistant.id);
    }

    turns.push({
      user,
      assistant: selectedAssistant,
      order: selectedAssistant
        ? getApiMessageTime(selectedAssistant)
        : getApiMessageTime(user),
    });
  }

  turns.sort((a, b) => a.order - b.order);

  return turns.flatMap(({ user, assistant }) =>
    assistant ? [user, assistant] : [user],
  );
}

function mergeApiMessages(
  existing: ApiMessage | undefined,
  incoming: ApiMessage,
): ApiMessage {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    metadata: {
      ...existing.metadata,
      ...incoming.metadata,
    },
    children: incoming.children ?? existing.children,
  };
}

function isExportableApiMessage(message: ApiMessage): boolean {
  const role = message.author?.role;

  return (
    (role === "user" || role === "assistant") &&
    !message.metadata?.is_visually_hidden_from_conversation &&
    (role === "user" || message.end_turn === true) &&
    Boolean(extractApiMessageText(message))
  );
}

/*
 * ---------------------------------------------------------
 * CONVERSATION ID
 * ---------------------------------------------------------
 */

function getConversationIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i);

  return match?.[1] ?? null;
}

/*
 * ---------------------------------------------------------
 * API MESSAGE TEXT
 * ---------------------------------------------------------
 */

function extractApiMessageText(message: ApiMessage): string {
  const parts = message.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
}

/*
 * ---------------------------------------------------------
 * PAGE BRIDGE REQUEST
 * ---------------------------------------------------------
 *
 * content.ts cannot directly access the authenticated
 * ChatGPT fetch context.
 *
 * pageBridge.js runs in ChatGPT's MAIN world and performs
 * the authenticated request.
 *
 * Communication:
 *
 * content.ts
 *     |
 *     | window.postMessage()
 *     v
 *
 * pageBridge.js
 *     |
 *     | authenticated fetch()
 *     v
 *
 * ChatGPT backend
 *
 *     |
 *     | JSON
 *     v
 *
 * pageBridge.js
 *     |
 *     | window.postMessage()
 *     v
 *
 * content.ts
 */

interface BridgeResponse {
  source?: string;
  type?: string;
  requestId?: string;
  data?: ConversationPage;
  error?: string;
}

function fetchConversationPage(url: string): Promise<ConversationPage> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    let finished = false;

    const cleanup = (): void => {
      window.removeEventListener("message", handleMessage);
    };

    const finishError = (error: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      reject(error);
    };

    const handleMessage = (event: MessageEvent<BridgeResponse>): void => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;

      if (!data || data.source !== "GPTExport") {
        return;
      }

      if (data.requestId !== requestId) {
        return;
      }

      if (data.type === "GPTEXPORT_API_ERROR") {
        finishError(
          new Error(data.error ?? "Unknown error from GPTExport page bridge."),
        );

        return;
      }

      if (data.type !== "GPTEXPORT_API_RESPONSE") {
        return;
      }

      if (!data.data) {
        finishError(
          new Error("GPTExport page bridge returned an empty API response."),
        );

        return;
      }

      if (finished) {
        return;
      }

      finished = true;

      cleanup();

      resolve(normalizeConversationPage(data.data));
    };

    window.addEventListener("message", handleMessage);

    console.log("GPTExport: requesting API page through bridge", url);

    window.postMessage(
      {
        source: "GPTExport",
        type: "GPTEXPORT_API_REQUEST",
        requestId,
        url,
      },
      "*",
    );

    /*
     * Safety timeout.
     *
     * If the bridge does not respond, don't leave
     * the Promise hanging forever.
     */
    window.setTimeout(() => {
      if (finished) {
        return;
      }

      finishError(
        new Error(
          "GPTExport page bridge timed out while requesting the conversation API.",
        ),
      );
    }, 30000);
  });
}

/*
 * ---------------------------------------------------------
 * LOAD ENTIRE CONVERSATION VIA API
 * ---------------------------------------------------------
 *
 * Initial request:
 *
 * /backend-api/conversations/{id}
 *     ?include_has_versions=true
 *     &num_turns=10
 *
 * Older messages:
 *
 * /backend-api/conversations/{id}/messages
 *     ?before={start_cursor}
 *     &include_has_versions=true
 *     &num_turns=10
 *
 * Pagination continues until:
 *
 * has_previous_page === false
 *
 * This avoids DOM virtualization and scrolling entirely.
 */

/*
 * Prevent an export from starting before the bridge
 * has had a chance to initialize.
 */
let bridgeReady = false;

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  if (!event.data || event.data.source !== "GPTExport") {
    return;
  }

  if (event.data.type === "BRIDGE_READY") {
    bridgeReady = true;

    console.log("GPTExport: page bridge ready");
  }
});

async function waitForBridge(): Promise<void> {
  if (bridgeReady) {
    return;
  }

  /*
   * Give the injected MAIN-world script a short time
   * to initialize.
   */
  const timeoutMs = 5000;
  const intervalMs = 50;

  const started = Date.now();

  while (!bridgeReady && Date.now() - started < timeoutMs) {
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, intervalMs),
    );
  }

  /*
   * We do not necessarily fail here.
   *
   * The bridge may already exist but its READY message
   * may have been emitted before this listener was added.
   *
   * The actual request below will provide the definitive
   * error if the bridge is unavailable.
   */
}

async function loadEntireConversation(): Promise<Message[]> {
  await waitForBridge();

  const conversationId = getConversationIdFromUrl();

  if (!conversationId) {
    throw new Error(
      "Could not determine the ChatGPT conversation ID from the current URL.",
    );
  }

  console.log("GPTExport: API conversation ID", conversationId);

  /*
   * -----------------------------------------------------
   * COLLECTED MESSAGES
   * -----------------------------------------------------
   */

  const rawById = new Map<string, ApiMessage>();
  const collected = new Map<string, ApiMessage>();

  /*
   * -----------------------------------------------------
   * COLLECT PAGE
   * -----------------------------------------------------
   */

  const collectPage = (currentPage: ConversationPage): void => {
    const messages = currentPage.messages ?? [];

    console.log(
      "GPTExport: API page contains",
      messages.length,
      "raw messages",
    );

    for (const message of messages) {
      const id = message.id;

      if (!id) {
        continue;
      }

      const mergedMessage = mergeApiMessages(rawById.get(id), message);

      rawById.set(id, mergedMessage);

      if (isExportableApiMessage(mergedMessage)) {
        collected.set(id, mergedMessage);
      }
    }

  };

  /*
   * -----------------------------------------------------
   * INITIAL PAGE
   * -----------------------------------------------------
   */

  const initialUrl =
    `/backend-api/conversations/${conversationId}` +
    `?include_has_versions=true&num_turns=10`;

  let page = await fetchConversationPage(initialUrl);

  let pageNumber = 0;
  const currentNode = page.current_node ?? null;

  collectPage(page);

  console.log(
    `GPTExport: API page ${pageNumber}, ` + `collected=${collected.size}`,
  );

  /*
   * -----------------------------------------------------
   * PAGINATION
   * -----------------------------------------------------
   */

  const seenCursors = new Set<string>();

  while (page.page_info?.has_previous_page === true) {
    const cursor = page.page_info.start_cursor;

    if (!cursor) {
      throw new Error(
        "ChatGPT reported that previous pages exist, but no pagination cursor was returned.",
      );
    }

    /*
     * Prevent infinite loops if the API returns
     * the same cursor twice.
     */
    if (seenCursors.has(cursor)) {
      throw new Error(
        "ChatGPT returned a repeated pagination cursor. Pagination was stopped to prevent an infinite loop.",
      );
    }

    seenCursors.add(cursor);

    pageNumber++;

    const nextUrl =
      `/backend-api/conversations/${conversationId}/messages` +
      `?before=${encodeURIComponent(cursor)}` +
      `&include_has_versions=true&num_turns=10`;

    page = await fetchConversationPage(nextUrl);

    collectPage(page);

    console.log(
      `GPTExport: API page ${pageNumber}, ` + `collected=${collected.size}`,
    );

    /*
     * Optional progress notification.
     */
    try {
      chrome.runtime.sendMessage({
        type: "EXPORT_PROGRESS",
        collected: collected.size,
      });
    } catch {
      /*
       * Progress reporting must never
       * break the export.
       */
    }
  }

  const messages = resolveActiveMessages(rawById, collected, currentNode);

  if (!currentNode) {
    console.warn(
      "GPTExport: API response did not include current_node; using chronological fallback",
    );
  }

  console.log("GPTExport: resolved active conversation", {
    currentNode,
    rawMessages: rawById.size,
    messages: messages.length,
  });

  /*
   * -----------------------------------------------------
   * CONVERT TO EXPORT FORMAT
   * -----------------------------------------------------
   */

  const result: Message[] = [];

  for (const message of messages) {
    const id = message.id;

    const role = message.author?.role;

    const content = extractApiMessageText(message);

    if (!id || (role !== "user" && role !== "assistant") || !content) {
      continue;
    }

    result.push({
      id,
      role,
      content,
      order: result.length,
    });
  }

  /*
   * -----------------------------------------------------
   * FINAL LOG
   * -----------------------------------------------------
   */

  console.log("GPTExport: API export complete", {
    conversationId,
    pages: pageNumber + 1,
    messages: result.length,
  });

  result.forEach((message, index) => {
    console.log(
      `${index + 1} ${message.role}:`,
      message.content.substring(0, 70),
    );
  });

  return result;
}

/*
 * ---------------------------------------------------------
 * READY
 * ---------------------------------------------------------
 */

console.log("GPTExport loaded");

console.log("GPTExport: ready");

window.postMessage(
  {
    source: "GPTExport",
    type: "READY",
  },
  "*",
);

/*
 * ---------------------------------------------------------
 * CONCURRENCY GUARD
 * ---------------------------------------------------------
 *
 * If popup sends LOAD_CONVERSATION more than once,
 * only one API pagination run is performed.
 */

let inFlightLoad: Promise<Message[]> | null = null;

function loadEntireConversationSingleFlight(): Promise<Message[]> {
  if (inFlightLoad) {
    console.log(
      "GPTExport: LOAD_CONVERSATION already in progress, reusing existing run",
    );

    return inFlightLoad;
  }

  const run = loadEntireConversation().finally(() => {
    if (inFlightLoad === run) {
      inFlightLoad = null;
    }
  });

  inFlightLoad = run;

  return run;
}

/*
 * ---------------------------------------------------------
 * CHROME MESSAGE HANDLER
 * ---------------------------------------------------------
 */

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
    },
    _sender,
    sendResponse,
  ) => {
    if (message.type !== "LOAD_CONVERSATION") {
      return false;
    }

    console.log("GPTExport: LOAD_CONVERSATION received");

    loadEntireConversationSingleFlight()
      .then((result) => {
        console.log("GPTExport: sending conversation", result);

        sendResponse({
          success: true,
          data: result,
        });
      })
      .catch((error) => {
        console.error("GPTExport: failed to load conversation", error);

        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    /*
     * Keep the Chrome message channel open while
     * the asynchronous operation is running.
     */
    return true;
  },
);
