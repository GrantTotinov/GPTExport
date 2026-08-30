interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    order: number;
}

let lastMessageCount = 0;

function getVisibleMessages(): Message[] {
    const result: Message[] = [];

    /*
     * ---------------------------------------------------------
     * ASSISTANT MESSAGES
     * ---------------------------------------------------------
     */
    const assistantMessages = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
    );

    for (const element of assistantMessages) {
        const id =
            element.getAttribute("data-message-id");

        if (!id) {
            continue;
        }

        const markdown =
            element.querySelector(".markdown");

        const content =
            markdown?.textContent?.trim();

        if (!content) {
            continue;
        }

        result.push({
            id,
            role: "assistant",
            content,
            order: 0
        });
    }

    /*
     * ---------------------------------------------------------
     * USER MESSAGES
     * ---------------------------------------------------------
     */
    const userMessages =
        document.querySelectorAll(".text-message");

    for (const element of userMessages) {
        const content =
            element
                .querySelector(
                    ".user-message-bubble-color"
                )
                ?.textContent
                ?.trim();

        if (!content) {
            continue;
        }

        result.push({
            id: `user-${content}`,
            role: "user",
            content,
            order: 0
        });
    }

    return result;
}

function logVisibleMessages() {
    const messages =
        getVisibleMessages();

    if (
        messages.length !==
        lastMessageCount
    ) {
        lastMessageCount =
            messages.length;

        console.log(
            `GPTExport: ${messages.length} messages currently visible`
        );

        console.log(messages);
    }
}

console.log(
    "GPTExport loaded"
);

/*
 * ---------------------------------------------------------
 * MUTATION OBSERVER
 * ---------------------------------------------------------
 */
const observer =
    new MutationObserver(() => {
        logVisibleMessages();
    });

observer.observe(
    document.body,
    {
        childList: true,
        subtree: true
    }
);

logVisibleMessages();

/*
 * ---------------------------------------------------------
 * WAIT
 * ---------------------------------------------------------
 */
async function wait(
    ms: number
): Promise<void> {
    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
    );
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
        document.querySelector<HTMLElement>(
            "[data-scroll-root]"
        );

    if (!scrollContainer) {
        console.error(
            "GPTExport: scroll container not found"
        );

        return [];
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
        return Array.from(
            document.querySelectorAll(
                '[data-message-author-role="assistant"], .text-message'
            )
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

        let content:
            | string
            | undefined;

        if (isAssistant) {
            content =
                element
                    .querySelector(
                        ".markdown"
                    )
                    ?.textContent
                    ?.trim();
        } else {
            content =
                element
                    .querySelector(
                        ".user-message-bubble-color"
                    )
                    ?.textContent
                    ?.trim();
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

    function collectVisibleMessages() {
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

                console.log(
                    "GPTExport: collected",
                    message.role,
                    message.content.substring(
                        0,
                        70
                    )
                );
            }

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
     * ---------------------------------------------------------
     * INITIAL COLLECTION
     * ---------------------------------------------------------
     */
    collectVisibleMessages();

    let topStableIterations = 0;
    let previousScrollTop = -1;

    /*
     * ---------------------------------------------------------
     * SCROLL THROUGH CONVERSATION
     * ---------------------------------------------------------
     */
    const SCROLL_WAIT_MS = 500;
    const STUCK_EXTRA_WAIT_MS = 800;
    const TOP_WAIT_MS = 600;

    for (
        let iteration = 0;
        iteration < 150;
        iteration++
    ) {
        const currentScrollTop =
            scrollContainer.scrollTop;

        const collectedBefore =
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
            topStableIterations++;

            /*
             * Give ChatGPT a short window to
             * render any remaining older messages.
             */
            await wait(TOP_WAIT_MS);

            collectVisibleMessages();

            /*
             * Require two stable checks.
             */
            if (
                scrollContainer.scrollTop <= 5 &&
                topStableIterations >= 2
            ) {
                console.log(
                    "GPTExport: reached top"
                );

                break;
            }
        } else {
            topStableIterations = 0;
        }

        /*
         * -----------------------------------------------------
         * SCROLL UP
         * -----------------------------------------------------
         *
         * Step is intentionally SMALLER than one
         * full viewport (0.6x) so consecutive steps
         * overlap. ChatGPT virtualizes the message
         * list, and if a step jumps too far, some
         * messages never get a chance to mount into
         * the DOM at all and are silently skipped -
         * no amount of waiting recovers them once
         * that happens. Speed instead comes from the
         * short waits below plus skipping the extra
         * wait when messages are still being found.
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

        await wait(SCROLL_WAIT_MS);

        /*
         * If scrolling didn't move AND no new
         * messages were collected this round,
         * ChatGPT is likely still loading -
         * give it a bit more time. If new
         * messages DID show up, skip the extra
         * wait and move on immediately.
         */
        const madeProgress =
            collected.size > collectedBefore;

        if (
            scrollContainer.scrollTop ===
                previousScrollTop &&
            !madeProgress
        ) {
            await wait(STUCK_EXTRA_WAIT_MS);
        }

        previousScrollTop =
            scrollContainer.scrollTop;
    }

    /*
     * ---------------------------------------------------------
     * FINAL COLLECTION
     * ---------------------------------------------------------
     */
    await wait(1000);

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
     * Messages with no incoming
     * relationships come first.
     */
    const queue: string[] = [];

    for (const message of messages) {
        if (
            (
                incoming.get(
                    message.id
                ) ?? 0
            ) === 0
        ) {
            queue.push(
                message.id
            );
        }
    }

    const orderedIds: string[] = [];

    /*
     * Topological sort.
     */
    while (
        queue.length > 0
    ) {
        const id =
            queue.shift()!;

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
                queue.push(
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
     async (message, _sender, sendResponse) => {
         if (message.type !== "LOAD_CONVERSATION") {
             return;
         }
 
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
                 error: String(error)
             });
         }
     }
 );
