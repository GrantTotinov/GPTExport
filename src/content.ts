interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    order: number;
}

let lastMessageCount = 0;

function getVisibleMessages(): Message[] {
    const result: Message[] = [];

    // Assistant messages
    const assistantMessages = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
    );

    for (const element of assistantMessages) {
        const id = element.getAttribute("data-message-id");

        if (!id) {
            continue;
        }

        const markdown = element.querySelector(".markdown");
        const content = markdown?.textContent?.trim();

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

    // User messages
    const userMessages = document.querySelectorAll(
        ".user-message-bubble-color"
    );

    for (const element of userMessages) {
        const content = element.textContent?.trim();

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
    const messages = getVisibleMessages();

    if (messages.length !== lastMessageCount) {
        lastMessageCount = messages.length;

        console.log(
            `GPTExport: ${messages.length} messages currently visible`
        );

        console.log(messages);
    }
}

console.log("GPTExport loaded");

const observer = new MutationObserver(() => {
    logVisibleMessages();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

logVisibleMessages();

async function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadEntireConversation(): Promise<Message[]> {
    const collected = new Map<string, Message>();

    const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-root]"
    );

    if (!scrollContainer) {
        console.error("GPTExport: scroll container not found");
        return [];
    }

    console.log("GPTExport: scroll container found");

    let userCounter = 0;

    /*
     * Keep a private identity for every user DOM element
     * we encounter.
     */
    const userIds = new WeakMap<Element, string>();

    function getMessageElements(): Element[] {
        return Array.from(
            document.querySelectorAll(
                '[data-message-author-role="assistant"], .user-message-bubble-color'
            )
        );
    }

    function getMessageId(element: Element): string | null {
        const assistantId =
            element.getAttribute("data-message-id");

        if (assistantId) {
            return assistantId;
        }

        /*
         * User messages don't expose data-message-id.
         *
         * Assign an internal ID to this DOM element.
         */
        if (!userIds.has(element)) {
            userIds.set(element, `user-${userCounter++}`);
        }

        return userIds.get(element)!;
    }

    function getMessage(element: Element): Message | null {
        const isAssistant = element.matches(
            '[data-message-author-role="assistant"]'
        );

        const role: Message["role"] = isAssistant
            ? "assistant"
            : "user";

        const id = getMessageId(element);

        if (!id) {
            return null;
        }

        let content: string | undefined;

        if (isAssistant) {
            content = element
                .querySelector(".markdown")
                ?.textContent
                ?.trim();
        } else {
            content = element.textContent?.trim();
        }

        if (!content) {
            return null;
        }

        return {
            id,
            role,
            content,
            order: 0
        };
    }

    /*
     * Store pairwise ordering information.
     *
     * A -> B means A appears before B in the DOM.
     */
    const before = new Map<string, Set<string>>();

    function collectVisibleMessages() {
        const elements = getMessageElements();

        const visible: {
            message: Message;
            element: Element;
            top: number;
        }[] = [];

        for (const element of elements) {
            const message = getMessage(element);

            if (!message) {
                continue;
            }

            if (!collected.has(message.id)) {
                collected.set(message.id, message);

                console.log(
                    "GPTExport: collected",
                    message.role,
                    message.content.substring(0, 70)
                );
            }

            const rect = element.getBoundingClientRect();

            visible.push({
                message,
                element,
                top: rect.top
            });
        }

        /*
         * Sort by actual vertical position.
         */
        visible.sort((a, b) => a.top - b.top);

        /*
         * Record ordering relationships.
         */
        for (let i = 0; i < visible.length; i++) {
            const currentId = visible[i].message.id;

            if (!before.has(currentId)) {
                before.set(currentId, new Set());
            }

            for (let j = i + 1; j < visible.length; j++) {
                const followingId =
                    visible[j].message.id;

                before
                    .get(currentId)!
                    .add(followingId);
            }
        }

        return visible;
    }

    /*
     * Initial collection.
     */
    collectVisibleMessages();

    let topStableIterations = 0;
    let previousScrollTop = -1;

    for (let iteration = 0; iteration < 100; iteration++) {
        const currentScrollTop =
            scrollContainer.scrollTop;

        const visible = collectVisibleMessages();

        console.log(
            `GPTExport: iteration ${iteration}, ` +
            `scrollTop=${currentScrollTop}, ` +
            `visible=${visible.length}, ` +
            `collected=${collected.size}`
        );

        /*
         * Reached the top.
         */
        if (currentScrollTop <= 5) {
            topStableIterations++;

            await wait(1000);

            collectVisibleMessages();

            if (
                scrollContainer.scrollTop <= 5 &&
                topStableIterations >= 2
            ) {
                console.log("GPTExport: reached top");
                break;
            }
        } else {
            topStableIterations = 0;
        }

        /*
         * Scroll upward.
         */
        const nextScrollTop = Math.max(
            0,
            currentScrollTop -
                scrollContainer.clientHeight * 0.8
        );

        scrollContainer.scrollTop = nextScrollTop;

        await wait(1000);

        /*
         * If scrolling stopped, give the page extra time.
         */
        if (
            scrollContainer.scrollTop ===
            previousScrollTop
        ) {
            await wait(1500);
        }

        previousScrollTop =
            scrollContainer.scrollTop;
    }

    /*
     * Final collection.
     */
    await wait(1000);
    collectVisibleMessages();

    const messages = Array.from(
        collected.values()
    );

    console.log(
        `GPTExport: collected ${messages.length} unique messages`
    );

    /*
     * ---------------------------------------------------------
     * TOPOLOGICAL SORT
     * ---------------------------------------------------------
     *
     * Pairwise DOM relationships are converted into a
     * global conversation order.
     */

    const incoming = new Map<string, number>();

    for (const message of messages) {
        incoming.set(message.id, 0);
    }

    for (const followingMessages of before.values()) {
        for (const followingId of followingMessages) {
            incoming.set(
                followingId,
                (incoming.get(followingId) ?? 0) + 1
            );
        }
    }

    const queue: string[] = [];

    for (const message of messages) {
        if ((incoming.get(message.id) ?? 0) === 0) {
            queue.push(message.id);
        }
    }

    const orderedIds: string[] = [];

    while (queue.length > 0) {
        const id = queue.shift()!;

        orderedIds.push(id);

        const followingMessages =
            before.get(id);

        if (!followingMessages) {
            continue;
        }

        for (const followingId of followingMessages) {
            const count =
                (incoming.get(followingId) ?? 0) - 1;

            incoming.set(followingId, count);

            if (count === 0) {
                queue.push(followingId);
            }
        }
    }

    /*
     * Build final array.
     */
    const messageById = new Map(
        messages.map(message => [
            message.id,
            message
        ])
    );

    const orderedMessages: Message[] = [];

    for (const id of orderedIds) {
        const message = messageById.get(id);

        if (message) {
            orderedMessages.push(message);
        }
    }

    /*
     * Safety fallback.
     *
     * If something could not be ordered, append it instead
     * of silently losing it.
     */
    if (orderedMessages.length !== messages.length) {
        for (const message of messages) {
            if (
                !orderedMessages.some(
                    x => x.id === message.id
                )
            ) {
                orderedMessages.push(message);
            }
        }
    }

    /*
     * Normalize order.
     */
    orderedMessages.forEach(
        (message, index) => {
            message.order = index;
        }
    );

    console.log(
        "GPTExport: final conversation order"
    );

    orderedMessages.forEach(
        (message, index) => {
            console.log(
                `${index + 1} ${message.role}:`,
                message.content.substring(0, 70)
            );
        }
    );

    console.log(orderedMessages);

    return orderedMessages;
}
console.log("GPTExport: ready");

window.postMessage(
    {
        source: "GPTExport",
        type: "READY"
    },
    "*"
);

window.addEventListener("message", async (event) => {
    if (
        event.source !== window ||
        event.data?.source !== "GPTExport_CONSOLE"
    ) {
        return;
    }

    if (event.data.type === "LOAD_CONVERSATION") {
        const result = await loadEntireConversation();

        console.log("GPTExport: RESULT", result);

        window.postMessage(
            {
                source: "GPTExport",
                type: "CONVERSATION_RESULT",
                data: result
            },
            "*"
        );
    }
});
