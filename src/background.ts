async function setupOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: "Copy exported ChatGPT conversation to clipboard.",
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "COPY_TO_CLIPBOARD") {
    return false;
  }

  (async () => {
    try {
      await setupOffscreenDocument();

      const response = await chrome.runtime.sendMessage({
        type: "OFFSCREEN_COPY",
        data: message.data,
      });

      sendResponse(response);
    } catch (error) {
      console.error("GPTExport: background clipboard failed", error);

      sendResponse({
        success: false,
        error: String(error),
      });
    }
  })();

  /*
   * MUST return true synchronously so Chrome
   * keeps the message channel open until
   * sendResponse is called inside the async IIFE
   * above. Without this, the channel closes
   * immediately and you get a DOMException.
   */
  return true;
});
