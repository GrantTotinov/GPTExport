import {
    SEPARATOR_TEXT,
    loadSettings
} from "./settings.ts";

import { stripMarkdown } from "./markdown-strip.ts";

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    order: number;
}

const copyButton = document.getElementById(
    "copy"
) as HTMLButtonElement;

const exportButton = document.getElementById(
    "export"
) as HTMLButtonElement;

const exportMenu = document.getElementById(
    "export-menu"
) as HTMLDivElement;

const exportMdButton = document.getElementById(
    "export-md"
) as HTMLButtonElement;

const exportTxtButton = document.getElementById(
    "export-txt"
) as HTMLButtonElement;

const optionsLink = document.getElementById(
    "options-link"
) as HTMLAnchorElement;

const allButtons = [
    copyButton,
    exportButton,
    exportMdButton,
    exportTxtButton
];

optionsLink.addEventListener("click", event => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
});

/*
 * ---------------------------------------------------------
 * EXPORT MENU TOGGLE
 * ---------------------------------------------------------
 */
exportButton.addEventListener("click", () => {
    exportMenu.classList.toggle("open");
});

document.addEventListener("click", event => {
    const target = event.target as Node;

    if (
        !exportButton.contains(target) &&
        !exportMenu.contains(target)
    ) {
        exportMenu.classList.remove("open");
    }
});

function closeExportMenu(): void {
    exportMenu.classList.remove("open");
}

/*
 * ---------------------------------------------------------
 * BUSY STATE
 * ---------------------------------------------------------
 */
function setBusy(
    button: HTMLButtonElement,
    text: string
): void {
    for (const button of allButtons) {
        button.disabled = true;
    }

    button.textContent = text;
}

function resetButtons(): void {
    for (const button of allButtons) {
        button.disabled = false;
    }

    copyButton.textContent = "Copy Conversation";
    exportButton.textContent = "Export Conversation ▾";
    exportMdButton.textContent = "Export as .md";
    exportTxtButton.textContent = "Export as .txt";
}

function showResult(
    button: HTMLButtonElement,
    text: string,
    ms: number
): void {
    button.textContent = text;

    setTimeout(resetButtons, ms);
}

/*
 * ---------------------------------------------------------
 * LIVE PROGRESS
 * ---------------------------------------------------------
 *
 * The content script sends EXPORT_PROGRESS messages while
 * it scrolls through the conversation. Reflect that on
 * whichever button triggered the export, so long
 * conversations don't look frozen.
 */
let activeButton: HTMLButtonElement | null = null;

chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== "EXPORT_PROGRESS") {
        return;
    }

    if (!activeButton) {
        return;
    }

    activeButton.textContent =
        `Loading... (${message.collected})`;
});

/*
 * ---------------------------------------------------------
 * FILENAME
 * ---------------------------------------------------------
 *
 * Builds a filesystem-safe filename from the tab title and
 * today's date, e.g. "chatgpt-export-easypay-transfer-help-2026-08-30.md".
 */
function buildFilename(
    tabTitle: string | undefined,
    extension: "md" | "txt"
): string {
    const date = new Date();

    const datePart =
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0");

    const rawTitle =
        (tabTitle ?? "conversation")
            /*
             * ChatGPT tab titles are usually just the
             * conversation title with no suffix, but
             * strip a trailing "ChatGPT" / separator
             * defensively in case that ever changes.
             */
            .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
            .trim();

    const safeTitle = rawTitle
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04FF]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

    const titlePart = safeTitle || "conversation";

    return `chatgpt-export-${titlePart}-${datePart}.${extension}`;
}

/*
 * ---------------------------------------------------------
 * FETCH + BUILD MARKDOWN
 * ---------------------------------------------------------
 *
 * Shared by the copy and export flows.
 */
async function fetchConversationMarkdown(
    button: HTMLButtonElement
): Promise<{ markdown: string; tabTitle: string | undefined }> {
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

    activeButton = button;

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
         * "Could not establish connection" means the
         * content script isn't running in this tab -
         * usually because the extension was reloaded
         * after the tab was already open. Reload the
         * tab and retry once.
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

    if (messages.length === 0) {
        throw new Error(
            "No messages found in this conversation"
        );
    }

    const settings = await loadSettings();

    const timestamp =
        settings.includeTimestamp
            ? `_Exported ${new Date().toLocaleString()}_\n\n`
            : "";

    const markdown =
        timestamp +
        messages
            .sort((a, b) => a.order - b.order)
            .map(message => {
                const roleLabel =
                    message.role === "user"
                        ? "User"
                        : "Assistant";

                let heading: string;

                switch (settings.headingStyle) {
                    case "bold":
                        heading = `**${roleLabel}:**`;
                        break;
                    case "none":
                        heading = "";
                        break;
                    case "h2":
                    default:
                        heading = `## ${roleLabel}`;
                        break;
                }

                return heading
                    ? `${heading}\n\n${message.content}`
                    : message.content;
            })
            .join(SEPARATOR_TEXT[settings.messageSeparator]);

    console.log(
        "GPTExport: generated markdown"
    );

    return { markdown, tabTitle: tab.title };
}

/*
 * ---------------------------------------------------------
 * COPY TO CLIPBOARD
 * ---------------------------------------------------------
 */
copyButton.addEventListener("click", async () => {
    console.log("GPTExport: copy clicked");

    closeExportMenu();
    setBusy(copyButton, "Loading...");

    try {
        const { markdown } =
            await fetchConversationMarkdown(copyButton);

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

        showResult(copyButton, "Copied!", 1500);

    } catch (error) {
        console.error(
            "GPTExport: copy failed",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        showResult(
            copyButton,
            message.length < 40 ? message : "Error",
            2500
        );
    } finally {
        activeButton = null;
    }
});

/*
 * ---------------------------------------------------------
 * DOWNLOAD (shared by .md / .txt)
 * ---------------------------------------------------------
 */
async function downloadAs(
    button: HTMLButtonElement,
    format: "md" | "txt"
): Promise<void> {
    closeExportMenu();
    setBusy(button, "Loading...");

    let objectUrl: string | undefined;

    try {
        const { markdown, tabTitle } =
            await fetchConversationMarkdown(button);

        const content =
            format === "txt"
                ? stripMarkdown(markdown)
                : markdown;

        const mimeType =
            format === "txt"
                ? "text/plain"
                : "text/markdown";

        const filename =
            buildFilename(tabTitle, format);

        const blob = new Blob(
            [content],
            { type: mimeType }
        );

        objectUrl = URL.createObjectURL(blob);

        const downloadId =
            await chrome.downloads.download({
                url: objectUrl,
                filename,
                saveAs: false
            });

        console.log(
            "GPTExport: download started",
            downloadId
        );

        showResult(button, "Downloaded!", 1500);

    } catch (error) {
        console.error(
            "GPTExport: download failed",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        showResult(
            button,
            message.length < 40 ? message : "Error",
            2500
        );
    } finally {
        activeButton = null;

        /*
         * Release the object URL once the download has
         * had time to start reading it. Chrome needs the
         * URL to remain valid slightly after the download
         * call returns.
         */
        if (objectUrl) {
            const url = objectUrl;
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
    }
}

exportMdButton.addEventListener("click", () => {
    console.log("GPTExport: export .md clicked");
    void downloadAs(exportMdButton, "md");
});

exportTxtButton.addEventListener("click", () => {
    console.log("GPTExport: export .txt clicked");
    void downloadAs(exportTxtButton, "txt");
});
