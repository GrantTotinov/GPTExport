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

  parent_message_id?: string | null;

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
    [key: string]: unknown;
  };
}

interface ConversationPage {
  messages?: ApiMessage[];

  page_info?: {
    start_cursor?: string | null;
    end_cursor?: string | null;
    has_previous_page?: boolean;
    has_next_page?: boolean;
  };
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

      resolve(data.data);
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
      console.log("GPTExport DEBUG MESSAGE:", {
        id: message.id,
        role: message.author?.role,
        status: message.status,
        end_turn: message.end_turn,
        recipient: message.recipient,
        channel: message.channel,
        content_type: message.content?.content_type,
        metadata: message.metadata,
        create_time: message.create_time,
      });

      const id = message.id;

      const role = message.author?.role;

      /*
       * Only user and assistant messages.
       */
      if (!id) {
        continue;
      }

      if (role !== "user" && role !== "assistant") {
        continue;
      }

      if (message.metadata?.is_visually_hidden_from_conversation) {
        continue;
      }

      /*
       * ChatGPT can store multiple intermediate assistant
       * messages for tool calls / web searches.
       *
       * Only the final assistant message of the turn
       * has end_turn === true.
       */

      if (role === "assistant" && message.end_turn === true) {
        console.log("GPTExport DEBUG FINAL ASSISTANT:", {
          id: message.id,
          create_time: message.create_time,
          recipient: message.recipient,
          channel: message.channel,
          metadata: message.metadata,
          content: extractApiMessageText(message).substring(0, 150),
        });
      }
      if (role === "assistant" && message.end_turn !== true) {
        continue;
      }

      const content = extractApiMessageText(message);

      if (!content) {
        continue;
      }

      /*
       * Deduplicate using the API message ID.
       */
      if (!collected.has(id)) {
        collected.set(id, message);

        console.log(
          "GPTExport: API collected",
          role,
          id,
          content.substring(0, 70),
        );
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

  /*
   * -----------------------------------------------------
   * SORT CHRONOLOGICALLY
   * -----------------------------------------------------
   *
   * API pagination is newest -> oldest.
   * create_time lets us restore chronological order.
   */

  const messages = Array.from(collected.values()).sort((a, b) => {
    const aTime = a.create_time ?? Number.MAX_SAFE_INTEGER;

    const bTime = b.create_time ?? Number.MAX_SAFE_INTEGER;

    return aTime - bTime;
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
