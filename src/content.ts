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

        /*
         * User messages don't currently expose the same
         * data-message-id attribute, so we use the element
         * itself as the visible message.
         */
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
    let nextOrder = 0;

    const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-root]"
    );

    if (!scrollContainer) {
        console.error("GPTExport: scroll container not found");
        return [];
    }

    console.log("GPTExport: scroll container found");

    let previousScrollTop = -1;
    let topStableIterations = 0;

    for (let iteration = 0; iteration < 100; iteration++) {

        // Collect everything currently rendered.
        const visibleMessages = getVisibleMessages();

        for (const message of visibleMessages) {
            if (!collected.has(message.id)) {
                collected.set(message.id, {
                    ...message,
                    order: nextOrder++
                });
        
                console.log(
                    "GPTExport: collected",
                    message.role,
                    message.content.substring(0, 50)
                );
            }
        }

        const currentScrollTop = scrollContainer.scrollTop;

        console.log(
            `GPTExport: iteration ${iteration}, scrollTop=${currentScrollTop}, collected=${collected.size}`
        );

        // We are at the top.
        if (currentScrollTop <= 5) {
            topStableIterations++;

            // Give ChatGPT time to render older messages.
            await wait(1000);

            const afterWaitMessages = getVisibleMessages();

            for (const message of afterWaitMessages) {
                if (!collected.has(message.id)) {
                    collected.set(message.id, message);

                    console.log(
                        "GPTExport: collected after reaching top",
                        message.role,
                        message.content.substring(0, 50)
                    );
                }
            }

            // If we're still at the top after waiting,
            // we've most likely reached the beginning.
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

        previousScrollTop = currentScrollTop;

        // Scroll significantly upward.
        scrollContainer.scrollTop = Math.max(
            0,
            currentScrollTop - scrollContainer.clientHeight * 0.8
        );

        await wait(1000);

        // If scrolling didn't move at all, try again after
        // giving the page more time to render.
        if (scrollContainer.scrollTop === previousScrollTop) {
            await wait(1500);
        }
    }

    // Convert to array.
    const messages = Array.from(collected.values());
    
    console.log(
        `GPTExport: collected ${messages.length} unique messages`
    );
    
    // Sort messages by their position in the conversation.
    // ChatGPT's DOM order represents the actual conversation order
    // whenever the messages are currently rendered together.
    messages.sort((a, b) => {
        const elements = document.querySelectorAll(
            '[data-message-author-role], .user-message-bubble-color'
        );
    
        const indexOf = (message: Message): number => {
            for (let i = 0; i < elements.length; i++) {
                const element = elements[i];
    
                const assistantId =
                    element.getAttribute("data-message-id");
    
                if (
                    assistantId === message.id ||
                    (
                        message.role === "user" &&
                        element.textContent?.trim() === message.content
                    )
                ) {
                    return i;
                }
            }
    
            return -1;
        };
    
        return indexOf(a) - indexOf(b);
    });
    
    console.log("GPTExport: sorted conversation");
    console.log(messages);
    
    return messages;

console.log("GPTExport: ready");

(window as any).postMessage({
    source: "GPTExport",
    type: "READY"
}, "*");

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

        window.postMessage({
            source: "GPTExport",
            type: "CONVERSATION_RESULT",
            data: result
        }, "*");
    }
});
