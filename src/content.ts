interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    order: number;
}

/*
 * ---------------------------------------------------------
 * HTML TO MARKDOWN
 * ---------------------------------------------------------
 *
 * ChatGPT renders assistant replies as real HTML (code
 * blocks, lists, bold/italic, links, headings...). Using
 * plain textContent throws all of that away. This walks
 * the DOM tree and reconstructs Markdown syntax instead.
 *
 * Deliberately conservative: unknown/unhandled elements
 * just recurse into their children, so nothing gets
 * silently dropped even if ChatGPT's markup changes.
 */
function htmlToMarkdown(root: Element): string {
    function renderInline(node: Node): string {
        return Array.from(node.childNodes)
            .map(renderNode)
            .join("");
    }

    function renderNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? "";
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return "";
        }

        const element = node as Element;
        const tag = element.tagName.toLowerCase();

        switch (tag) {
            case "strong":
            case "b":
                return `**${renderInline(element)}**`;

            case "em":
            case "i":
                return `*${renderInline(element)}*`;

            case "code": {
                /*
                 * Inline code, unless it's already
                 * inside a <pre> (handled separately).
                 */
                if (element.closest("pre")) {
                    return element.textContent ?? "";
                }

                return `\`${element.textContent ?? ""}\``;
            }

            case "pre": {
                const codeElement =
                    element.querySelector("code");

                const language =
                    codeElement
                        ?.className
                        ?.match(/language-(\S+)/)
                        ?.[1] ?? "";

                const code =
                    (codeElement ?? element)
                        .textContent ?? "";

                return (
                    `\n\`\`\`${language}\n` +
                    `${code.replace(/\n$/, "")}\n` +
                    "```\n"
                );
            }

            case "a": {
                const href =
                    element.getAttribute("href") ?? "";

                const text = renderInline(element);

                return href
                    ? `[${text}](${href})`
                    : text;
            }

            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6": {
                const level =
                    Number(tag.charAt(1));

                return (
                    `\n${"#".repeat(level)} ` +
                    `${renderInline(element)}\n`
                );
            }

            case "blockquote": {
                const text =
                    renderInline(element).trim();

                const quoted = text
                    .split("\n")
                    .map(line => `> ${line}`)
                    .join("\n");

                return `\n${quoted}\n`;
            }

            case "ul":
            case "ol": {
                const items =
                    Array.from(
                        element.children
                    ).filter(
                        child =>
                            child.tagName.toLowerCase() ===
                            "li"
                    );

                const rendered = items
                    .map((item, index) => {
                        const bullet =
                            tag === "ol"
                                ? `${index + 1}.`
                                : "-";

                        const text =
                            renderInline(item).trim();

                        return `${bullet} ${text}`;
                    })
                    .join("\n");

                return `\n${rendered}\n`;
            }

            case "li":
                /*
                 * Handled by the ul/ol case above;
                 * skip if encountered standalone.
                 */
                return renderInline(element);

            case "br":
                return "\n";

            case "p":
            case "div": {
                const inner =
                    renderInline(element).trim();

                return inner ? `${inner}\n\n` : "";
            }

            case "hr":
                return "\n---\n";

            case "table": {
                /*
                 * Minimal table support: keep it
                 * readable even if not perfectly
                 * formatted markdown table syntax.
                 */
                const rows =
                    Array.from(
                        element.querySelectorAll("tr")
                    );

                const rendered = rows
                    .map(row => {
                        const cells =
                            Array.from(
                                row.querySelectorAll(
                                    "td, th"
                                )
                            ).map(cell =>
                                renderInline(
                                    cell
                                ).trim()
                            );

                        return `| ${cells.join(" | ")} |`;
                    })
                    .join("\n");

                return `\n${rendered}\n`;
            }

            default:
                /*
                 * Unknown element - don't lose its
                 * content, just recurse into children.
                 */
                return renderInline(element);
        }
    }

    const result = renderInline(root);

    /*
     * Collapse 3+ consecutive blank lines down to
     * at most one, which tends to accumulate from
     * nested block elements.
     */
    return result
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/*
 * ---------------------------------------------------------
 * SELECTORS
 * ---------------------------------------------------------
 *
 * ChatGPT's DOM structure isn't a public API and can change
 * without notice. Centralizing every selector here (with
 * fallback alternatives) means a layout change only needs
 * a fix in one place, and failures produce a clear error
 * instead of a silently empty export.
 */
const SELECTORS = {
    scrollContainer: [
        "[data-scroll-root]",
        "main [role=\"presentation\"]",
        "main"
    ],
    messageContainer: [
        '[data-message-author-role="assistant"], .text-message',
        '[data-message-author-role]'
    ],
    assistantMessage: [
        '[data-message-author-role="assistant"]'
    ],
    assistantContent: [
        ".markdown",
        '[data-message-author-role="assistant"] .prose',
        '[data-message-author-role="assistant"]'
    ],
    userContent: [
        ".user-message-bubble-color",
        '[data-message-author-role="user"] .whitespace-pre-wrap',
        '[data-message-author-role="user"]'
    ]
} as const;

/*
 * ---------------------------------------------------------
 * QUERY HELPERS WITH FALLBACK
 * ---------------------------------------------------------
 *
 * Try each selector in order and return the first match.
 * Throwing an explicit, actionable error (instead of
 * quietly returning null/empty) turns a silent broken
 * export into something the user can actually report.
 */
function queryOneWithFallback(
    root: ParentNode,
    selectors: readonly string[],
    description: string
): Element | null {
    for (const selector of selectors) {
        const found = root.querySelector(selector);

        if (found) {
            return found;
        }
    }

    console.warn(
        `GPTExport: could not find ${description} ` +
        `using any known selector - ChatGPT's layout ` +
        "may have changed. Selectors tried: " +
        selectors.join(", ")
    );

    return null;
}

function queryAllWithFallback(
    root: ParentNode,
    selectors: readonly string[],
    description: string
): Element[] {
    for (const selector of selectors) {
        const found = root.querySelectorAll(selector);

        if (found.length > 0) {
            return Array.from(found);
        }
    }

    console.warn(
        `GPTExport: could not find any ${description} ` +
        "using any known selector - ChatGPT's layout " +
        "may have changed. Selectors tried: " +
        selectors.join(", ")
    );

    return [];
}

console.log(
    "GPTExport loaded"
);

/*
 * ---------------------------------------------------------
 * WAIT FOR DOM SETTLE
 * ---------------------------------------------------------
 *
 * Instead of always waiting a fixed number of ms after
 * scrolling, watch the container for actual DOM mutations
 * and resolve as soon as things go quiet (debounced by
 * quietMs). This is both faster (short chats/fast renders
 * don't wait longer than needed) and safer (slow renders
 * on long chats naturally get more time instead of being
 * cut off by a fixed timeout).
 *
 * maxMs is a hard safety cap so a container that never
 * "settles" can't hang the export forever.
 */
async function waitForDomSettle(
    target: HTMLElement,
    quietMs: number,
    maxMs: number
): Promise<void> {
    return new Promise(resolve => {
        let settleTimer: ReturnType<typeof setTimeout>;

        const finish = () => {
            clearTimeout(settleTimer);
            clearTimeout(hardTimer);
            observer.disconnect();
            resolve();
        };

        const observer = new MutationObserver(() => {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(finish, quietMs);
        });

        observer.observe(target, {
            childList: true,
            subtree: true
        });

        /*
         * Start the quiet timer immediately too, in
         * case no mutation happens at all (e.g. we're
         * already at the top and nothing new loads).
         */
        settleTimer = setTimeout(finish, quietMs);

        const hardTimer = setTimeout(
            finish,
            maxMs
        );
    });
}

/*
 * ---------------------------------------------------------
 * LOAD ENTIRE CONVERSATION
 * ---------------------------------------------------------
 */
async function loadEntireConversation(): Promise<Message[]> {
    const collected =
        new Map<string, Message>();

    /*
     * Find ChatGPT's scroll container.
     */
    const scrollContainer =
        queryOneWithFallback(
            document,
            SELECTORS.scrollContainer,
            "the conversation scroll container"
        ) as HTMLElement | null;

    if (!scrollContainer) {
        throw new Error(
            "Couldn't find the conversation area on this " +
            "page. ChatGPT may have changed its layout - " +
            "please open an issue on the GPTExport GitHub " +
            "repo with a screenshot of the browser console."
        );
    }

    console.log(
        "GPTExport: scroll container found"
    );

    /*
     * ---------------------------------------------------------
     * MESSAGE ELEMENTS
     * ---------------------------------------------------------
     */
    function getMessageElements(): Element[] {
        return queryAllWithFallback(
            document,
            SELECTORS.messageContainer,
            "conversation messages"
        );
    }

    /*
     * ---------------------------------------------------------
     * STABLE STRING HASH
     * ---------------------------------------------------------
     *
     * Small, fast, deterministic hash (djb2 variant).
     * Used to derive a stable id for user messages from
     * their text content, since ChatGPT virtualizes the
     * DOM and re-creates elements as you scroll - a
     * WeakMap keyed by element identity breaks in that
     * case (same message, new element, new "id", causing
     * messages to appear duplicated or dropped).
     */
    function hashString(value: string): string {
        let hash = 5381;

        for (let i = 0; i < value.length; i++) {
            hash =
                ((hash << 5) + hash + value.charCodeAt(i)) |
                0;
        }

        return (hash >>> 0).toString(36);
    }

    /*
     * ---------------------------------------------------------
     * MESSAGE ID
     * ---------------------------------------------------------
     */
    function getMessageId(
        element: Element,
        content: string
    ): string {
        /*
         * Assistant messages have
         * a real message ID.
         */
        const assistantId =
            element.getAttribute(
                "data-message-id"
            );

        if (assistantId) {
            return assistantId;
        }

        /*
         * User messages don't expose a stable
         * data-message-id, and their DOM element
         * gets recreated when ChatGPT virtualizes
         * the scroll list. Derive the id from the
         * message content instead, so the same
         * message always maps to the same id no
         * matter how many times its element is
         * re-created.
         */
        return `user-${hashString(content)}`;
    }

    /*
     * ---------------------------------------------------------
     * MESSAGE EXTRACTION
     * ---------------------------------------------------------
     */
    function getMessage(
        element: Element
    ): Message | null {
        const isAssistant =
            element.matches(
                '[data-message-author-role="assistant"]'
            );

        const role: Message["role"] =
            isAssistant
                ? "assistant"
                : "user";

        let content: string;

        if (isAssistant) {
            const markdownElement =
                queryOneWithFallback(
                    element,
                    SELECTORS.assistantContent,
                    "assistant message content"
                ) ?? element;

            content = htmlToMarkdown(markdownElement);
        } else {
            const bubbleElement =
                queryOneWithFallback(
                    element,
                    SELECTORS.userContent,
                    "user message content"
                ) ?? element;

            content = htmlToMarkdown(bubbleElement);
        }

        if (!content) {
            return null;
        }

        const id =
            getMessageId(element, content);

        return {
            id,
            role,
            content,
            order: 0
        };
    }

    /*
     * ---------------------------------------------------------
     * ORDERING
     * ---------------------------------------------------------
     *
     * A -> B means:
     *
     * A appears before B.
     *
     * This is necessary because ChatGPT
     * virtualizes the conversation DOM.
     */
    const before =
        new Map<string, Set<string>>();

    /*
     * Records the snapshot index (0, 1, 2, ...) in which
     * each message was first seen. Since we scroll
     * monotonically from the newest message toward the
     * oldest, an earlier discovery index means a NEWER
     * message. This acts as a fallback ordering signal for
     * message pairs that never appeared in the same
     * snapshot together (e.g. two separate lazy-load
     * batches with no overlapping messages between them) -
     * in that case the "before" graph has no edge between
     * them at all, and topological sort would otherwise
     * place them in arbitrary (discovery/insertion) order.
     */
    const discoveryIndex =
        new Map<string, number>();

    let snapshotCounter = 0;

    function collectVisibleMessages() {
        const currentSnapshot =
            snapshotCounter++;

        const elements =
            getMessageElements();

        const visible: {
            message: Message;
            element: Element;
            top: number;
        }[] = [];

        for (const element of elements) {
            const message =
                getMessage(element);

            if (!message) {
                continue;
            }

            if (
                !collected.has(
                    message.id
                )
            ) {
                collected.set(
                    message.id,
                    message
                );

                discoveryIndex.set(
                    message.id,
                    currentSnapshot
                );

                console.log(
                    "GPTExport: collected",
                    message.role,
                    message.content.substring(
                        0,
                        70
                    )
                );
            }

            /*
             * getBoundingClientRect().top is viewport-
             * relative, which is exactly what we want here:
             * all elements in THIS snapshot share the same
             * scroll position at this instant, so their
             * relative order is reliable. We only use this
             * to order elements WITHIN a single snapshot
             * (see the "before" graph below) - we never
             * compare "top" values across different calls
             * to collectVisibleMessages(), since the scroll
             * position (and thus what "top" means) changes
             * between calls.
             */
            const rect =
                element.getBoundingClientRect();

            visible.push({
                message,
                element,
                top: rect.top
            });
        }

        /*
         * Sort according to actual
         * vertical position.
         */
        visible.sort(
            (a, b) =>
                a.top - b.top
        );

        /*
         * Record relationships.
         */
        for (
            let i = 0;
            i < visible.length;
            i++
        ) {
            const currentId =
                visible[i]
                    .message
                    .id;

            if (
                !before.has(
                    currentId
                )
            ) {
                before.set(
                    currentId,
                    new Set()
                );
            }

            for (
                let j = i + 1;
                j < visible.length;
                j++
            ) {
                const followingId =
                    visible[j]
                        .message
                        .id;

                before
                    .get(currentId)!
                    .add(followingId);
            }
        }

        return visible;
    }

    /*
     * Rather than guessing a fixed delay after each
     * scroll step, we watch the scroll container with
     * a MutationObserver and resolve as soon as it
     * stops changing (settleMs of silence). This adapts
     * automatically: fast renders don't wait longer than
     * needed, slow renders on huge chats naturally get
     * more time instead of being cut off.
     */
    const SETTLE_QUIET_MS = 150;
    const SETTLE_MAX_MS = 2500;
    const TOP_SETTLE_QUIET_MS = 400;
    const TOP_SETTLE_MAX_MS = 2500;

    /*
     * How many consecutive iterations must show BOTH
     * scrollTop <= 5 AND no growth in collected message
     * count before we consider the conversation fully
     * loaded. Very long conversations can lazy-load in
     * many separate batches even after scrollTop visually
     * hits 0 repeatedly - each batch briefly grows the
     * scroll height again once it renders, then settles
     * back at 0. Requiring several stable rounds (not
     * just two) avoids stopping mid-batch.
     */
    const REQUIRED_STABLE_ROUNDS = 6;

    /*
     * ---------------------------------------------------------
     * SCROLL TO BOTTOM FIRST
     * ---------------------------------------------------------
     *
     * If the user has scrolled up mid-conversation before
     * opening the popup, starting the upward scroll from
     * that arbitrary position would silently skip every
     * message below it (including the most recent ones).
     * Jump to the bottom first so the upward scroll always
     * starts from the actual end of the conversation.
     */
    scrollContainer.scrollTop =
        scrollContainer.scrollHeight;

    await waitForDomSettle(
        scrollContainer,
        TOP_SETTLE_QUIET_MS,
        TOP_SETTLE_MAX_MS
    );

    /*
     * ---------------------------------------------------------
     * INITIAL COLLECTION
     * ---------------------------------------------------------
     */
    collectVisibleMessages();

    let topStableIterations = 0;

    /*
     * ---------------------------------------------------------
     * SCROLL THROUGH CONVERSATION
     * ---------------------------------------------------------
     */

    for (
        let iteration = 0;
        iteration < 300;
        iteration++
    ) {
        const currentScrollTop =
            scrollContainer.scrollTop;

        const collectedBeforeRound =
            collected.size;

        const visible =
            collectVisibleMessages();

        console.log(
            `GPTExport: iteration ${iteration}, ` +
            `scrollTop=${currentScrollTop}, ` +
            `visible=${visible.length}, ` +
            `collected=${collected.size}`
        );

        /*
         * -----------------------------------------------------
         * TOP DETECTION
         * -----------------------------------------------------
         */
        if (
            currentScrollTop <= 5
        ) {
            /*
             * Give ChatGPT a window to render any
             * remaining older messages, but only as
             * long as the DOM is actually still
             * changing.
             */
            await waitForDomSettle(
                scrollContainer,
                TOP_SETTLE_QUIET_MS,
                TOP_SETTLE_MAX_MS
            );

            collectVisibleMessages();

            const stillAtTop =
                scrollContainer.scrollTop <= 5;

            const stillGrowing =
                collected.size > collectedBeforeRound;

            if (stillAtTop && !stillGrowing) {
                topStableIterations++;
            } else {
                /*
                 * Either we got bumped away from the
                 * top (more content loaded above,
                 * pushing scroll position down) or new
                 * messages just appeared - either way,
                 * this wasn't a stable round. Reset and
                 * keep trying; the next iterations will
                 * scroll up further into whatever just
                 * loaded.
                 */
                topStableIterations = 0;
            }

            if (topStableIterations >= REQUIRED_STABLE_ROUNDS) {
                console.log(
                    "GPTExport: reached top"
                );

                break;
            }

            /*
             * Nudge: some lazy-loading triggers need an
             * actual scroll event to fire (not just
             * sitting at position 0) to fetch the next
             * batch of older messages. Bump down and
             * back up before the next round.
             */
            scrollContainer.scrollTop = 40;

            await waitForDomSettle(
                scrollContainer,
                150,
                600
            );

            scrollContainer.scrollTop = 0;
        } else {
            topStableIterations = 0;
        }

        /*
         * -----------------------------------------------------
         * SCROLL UP
         * -----------------------------------------------------
         *
         * Step is intentionally SMALLER than one full
         * viewport (0.6x) so consecutive steps overlap.
         * ChatGPT virtualizes the message list, and if a
         * step jumps too far, some messages never get a
         * chance to mount into the DOM at all and are
         * silently skipped - no amount of waiting
         * recovers them once that happens.
         */
        const nextScrollTop =
            Math.max(
                0,
                currentScrollTop -
                    scrollContainer.clientHeight *
                        0.6
            );

        scrollContainer.scrollTop =
            nextScrollTop;

        /*
         * Wait only as long as the DOM is actually
         * mutating - this is the main speed win over
         * a fixed delay. Short chats/fast renders
         * settle almost instantly; slow renders on
         * long chats get up to SETTLE_MAX_MS.
         */
        await waitForDomSettle(
            scrollContainer,
            SETTLE_QUIET_MS,
            SETTLE_MAX_MS
        );

    }

    /*
     * ---------------------------------------------------------
     * FINAL COLLECTION
     * ---------------------------------------------------------
     */
    await waitForDomSettle(
        scrollContainer,
        TOP_SETTLE_QUIET_MS,
        TOP_SETTLE_MAX_MS
    );

    collectVisibleMessages();

    const messages =
        Array.from(
            collected.values()
        );

    console.log(
        `GPTExport: collected ${messages.length} unique messages`
    );

    /*
     * ---------------------------------------------------------
     * TOPOLOGICAL SORT
     * ---------------------------------------------------------
     */
    const incoming =
        new Map<string, number>();

    for (const message of messages) {
        incoming.set(
            message.id,
            0
        );
    }

    /*
     * Count incoming relationships.
     */
    for (
        const followingMessages
        of before.values()
    ) {
        for (
            const followingId
            of followingMessages
        ) {
            incoming.set(
                followingId,
                (
                    incoming.get(
                        followingId
                    ) ?? 0
                ) + 1
            );
        }
    }

    /*
     * Messages with no incoming relationships are
     * available to be placed next. Instead of a plain
     * FIFO queue (which would fall back to arbitrary
     * insertion order whenever multiple messages become
     * available at once with no "before" edge between
     * them - e.g. two disconnected lazy-load batches),
     * we always pick the available message with the
     * earliest discovery index. Since we scroll from
     * newest to oldest, earlier discovery = newer
     * message, so this keeps disconnected batches in
     * the right relative order even without a direct
     * graph edge between them.
     */
    const available: string[] = [];

    for (const message of messages) {
        if (
            (
                incoming.get(
                    message.id
                ) ?? 0
            ) === 0
        ) {
            available.push(
                message.id
            );
        }
    }

    function takeEarliestDiscovered(): string {
        let bestIndex = 0;

        let bestDiscovery =
            discoveryIndex.get(
                available[0]
            ) ?? Number.MAX_SAFE_INTEGER;

        for (
            let i = 1;
            i < available.length;
            i++
        ) {
            const candidateDiscovery =
                discoveryIndex.get(
                    available[i]
                ) ?? Number.MAX_SAFE_INTEGER;

            if (
                candidateDiscovery <
                bestDiscovery
            ) {
                bestDiscovery =
                    candidateDiscovery;

                bestIndex = i;
            }
        }

        const [id] =
            available.splice(bestIndex, 1);

        return id;
    }

    const orderedIds: string[] = [];

    /*
     * Topological sort.
     */
    while (
        available.length > 0
    ) {
        const id =
            takeEarliestDiscovered();

        orderedIds.push(id);

        const followingMessages =
            before.get(id);

        if (!followingMessages) {
            continue;
        }

        for (
            const followingId
            of followingMessages
        ) {
            const count =
                (
                    incoming.get(
                        followingId
                    ) ?? 0
                ) - 1;

            incoming.set(
                followingId,
                count
            );

            if (count === 0) {
                available.push(
                    followingId
                );
            }
        }
    }

    /*
     * ---------------------------------------------------------
     * BUILD FINAL ARRAY
     * ---------------------------------------------------------
     */
    const messageById =
        new Map(
            messages.map(
                message => [
                    message.id,
                    message
                ]
            )
        );

    const orderedMessages:
        Message[] = [];

    for (
        const id
        of orderedIds
    ) {
        const message =
            messageById.get(id);

        if (message) {
            orderedMessages.push(
                message
            );
        }
    }

    /*
     * ---------------------------------------------------------
     * SAFETY FALLBACK
     * ---------------------------------------------------------
     */
    if (
        orderedMessages.length !==
        messages.length
    ) {
        for (
            const message
            of messages
        ) {
            if (
                !orderedMessages.some(
                    x =>
                        x.id ===
                        message.id
                )
            ) {
                orderedMessages.push(
                    message
                );
            }
        }
    }

    /*
     * ---------------------------------------------------------
     * NORMALIZE ORDER
     * ---------------------------------------------------------
     */
    orderedMessages.forEach(
        (message, index) => {
            message.order =
                index;
        }
    );

    /*
     * ---------------------------------------------------------
     * LOG FINAL RESULT
     * ---------------------------------------------------------
     */
    console.log(
        "GPTExport: final conversation order"
    );

    orderedMessages.forEach(
        (message, index) => {
            console.log(
                `${index + 1} ${message.role}:`,
                message.content.substring(
                    0,
                    70
                )
            );
        }
    );

    console.log(
        orderedMessages
    );

    return orderedMessages;
}

/*
 * ---------------------------------------------------------
 * READY
 * ---------------------------------------------------------
 */
console.log(
    "GPTExport: ready"
);

window.postMessage(
    {
        source: "GPTExport",
        type: "READY"
    },
    "*"
);

/*
 * ---------------------------------------------------------
 * CHROME MESSAGE HANDLER
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
        if (message.type !== "LOAD_CONVERSATION") {
            return false;
        }

        (async () => {
            try {
                console.log(
                    "GPTExport: LOAD_CONVERSATION received"
                );

                const result =
                    await loadEntireConversation();

                console.log(
                    "GPTExport: sending conversation",
                    result
                );

                sendResponse({
                    success: true,
                    data: result
                });
            } catch (error) {
                console.error(
                    "GPTExport: failed to load conversation",
                    error
                );

                sendResponse({
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error)
                });
            }
        })();

        return true;
    }
);
