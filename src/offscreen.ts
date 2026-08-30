function copyUsingExecCommand(text: string): boolean {
    const textarea =
        document.getElementById(
            "clipboard-helper"
        ) as HTMLTextAreaElement | null;

    if (!textarea) {
        console.error(
            "GPTExport: clipboard-helper textarea missing"
        );

        return false;
    }

    textarea.value = text;
    textarea.focus();
    textarea.select();

    const success = document.execCommand("copy");

    textarea.value = "";

    return success;
}

chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
        if (message.type !== "OFFSCREEN_COPY") {
            return false;
        }

        try {
            const text = String(message.data ?? "");

            const success = copyUsingExecCommand(text);

            if (!success) {
                throw new Error(
                    "execCommand('copy') returned false"
                );
            }

            console.log(
                "GPTExport: offscreen clipboard write successful"
            );

            sendResponse({
                success: true
            });
        } catch (error) {
            console.error(
                "GPTExport: offscreen clipboard failed",
                error
            );

            sendResponse({
                success: false,
                error: String(error)
            });
        }

        return true;
    }
);
