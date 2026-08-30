interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    order: number;
}

const button = document.getElementById(
    "export"
) as HTMLButtonElement;

function showError(text: string, ms: number): void {
    button.textContent = text;

    setTimeout(() => {
        button.textContent =
            "Export Conversation";

        button.disabled = false;
    }, ms);
}

button.addEventListener("click", async () => {
    console.log("GPTExport: export clicked");

    button.disabled = true;
    button.textContent = "Loading...";

    try {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        if (!tab.id) {
            throw new Error("No active tab");
        }

        if (!tab.url?.startsWith("https://chatgpt.com/")) {
            throw new Error(
                "Open a chatgpt.com conversation first"
            );
        }

        console.log(
            "GPTExport: requesting conversation"
        );

        let response;

        try {
            response =
                await chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: "LOAD_CONVERSATION"
                    }
                );
        } catch (sendError) {
            /*
             * "Could not establish connection" means
             * the content script isn't running in this
             * tab - usually because the extension was
             * reloaded after the tab was already open.
             * Reload the tab and retry once.
             */
            console.warn(
                "GPTExport: no content script, reloading tab and retrying",
                sendError
            );

            await chrome.tabs.reload(tab.id);

            await new Promise(resolve =>
                setTimeout(resolve, 2000)
            );

            response =
                await chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: "LOAD_CONVERSATION"
                    }
                );
        }

        if (!response?.success) {
            throw new Error(
                response?.error ??
                "Failed to load conversation"
            );
        }

        const messages =
            response.data as Message[];

        console.log(
            `GPTExport: received ${messages.length} messages`
        );

        const markdown = messages
            .sort((a, b) => a.order - b.order)
            .map(message => {
                const role =
                    message.role === "user"
                        ? "User"
                        : "Assistant";

                return `## ${role}\n\n${message.content}`;
            })
            .join("\n\n");

        console.log(
            "GPTExport: generated markdown"
        );

        const copyResponse =
            await chrome.runtime.sendMessage({
                type: "COPY_TO_CLIPBOARD",
                data: markdown
            });

        console.log(
            "GPTExport: clipboard response",
            copyResponse
        );

        if (!copyResponse?.success) {
            throw new Error(
                copyResponse?.error ??
                "Failed to copy markdown"
            );
        }

        button.textContent = "Copied!";

        setTimeout(() => {
            button.textContent =
                "Export Conversation";

            button.disabled = false;
        }, 1500);

    } catch (error) {
        console.error(
            "GPTExport: export failed",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        showError(
            message.length < 40
                ? message
                : "Error",
            2500
        );
    }
});
