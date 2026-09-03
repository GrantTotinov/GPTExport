/*
 * GPTExport - MAIN world bridge
 *
 * This file runs in the ChatGPT page's MAIN world.
 *
 * It observes authenticated ChatGPT conversation requests
 * and performs conversation API requests inside the same
 * page context.
 */

(() => {
  const originalFetch = window.fetch;

  let authenticatedHeaders: Headers | null = null;

  /*
   * ---------------------------------------------------------
   * CONVERSATION URL
   * ---------------------------------------------------------
   */

  function isConversationUrl(url: string): boolean {
    return (
      url.includes("/backend-api/conversations/") ||
      url.includes("/backend-api/conversation/")
    );
  }

  /*
   * ---------------------------------------------------------
   * REQUEST URL
   * ---------------------------------------------------------
   */

  function getRequestUrl(input: RequestInfo | URL): string {
    if (input instanceof Request) {
      return input.url;
    }

    return String(input);
  }

  /*
   * ---------------------------------------------------------
   * INTERCEPT FETCH
   * ---------------------------------------------------------
   *
   * ChatGPT itself makes authenticated requests to:
   *
   * /backend-api/conversations/...
   *
   * We observe one of these requests and copy its headers
   * into MAIN-world memory.
   *
   * Nothing is persisted to storage.
   */

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = getRequestUrl(input);

    let isConversationRequest = false;

    try {
      isConversationRequest = isConversationUrl(url);
    } catch {
      isConversationRequest = false;
    }

    /*
     * Capture authentication headers from the
     * existing ChatGPT request.
     */
    if (isConversationRequest) {
      try {
        if (input instanceof Request) {
          /*
           * Clone only for reading headers.
           *
           * The original Request is still passed
           * untouched to fetch below.
           */
          const cloned = input.clone();

          authenticatedHeaders = new Headers(cloned.headers);
        } else {
          authenticatedHeaders = new Headers(init?.headers);
        }

        console.log(
          "GPTExport bridge: authenticated conversation request detected",
        );
      } catch (error) {
        console.warn(
          "GPTExport bridge: could not inspect request headers",
          error,
        );
      }
    }

    /*
     * IMPORTANT
     *
     * Do NOT use `arguments`.
     *
     * Do NOT create a new Request from `input`.
     *
     * Forward the original input/init directly.
     *
     * This prevents:
     *
     * "Request object already been used"
     */
    const response = await originalFetch(input, init);

    if (isConversationRequest && response.ok) {
      console.log("GPTExport bridge: conversation response", response.status);
    }

    return response;
  };

  /*
   * ---------------------------------------------------------
   * GPTExport API REQUEST
   * ---------------------------------------------------------
   *
   * content.ts sends:
   *
   * {
   *     source: "GPTExport",
   *     type: "GPTEXPORT_API_REQUEST",
   *     requestId,
   *     url
   * }
   *
   * This listener performs the authenticated request
   * inside the ChatGPT MAIN world.
   */

  window.addEventListener("message", (event) => {
    /*
     * Only accept messages originating from this page.
     */
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== "GPTExport"
    ) {
      return;
    }

    if (event.data.type !== "GPTEXPORT_API_REQUEST") {
      return;
    }

    const requestId = String(event.data.requestId);

    const url = String(event.data.url ?? "");

    /*
     * -------------------------------------------------
     * VALIDATE URL
     * -------------------------------------------------
     */

    if (!url) {
      window.postMessage(
        {
          source: "GPTExport",
          type: "GPTEXPORT_API_ERROR",
          requestId,
          error: "Missing API URL",
        },
        "*",
      );

      return;
    }

    if (!isConversationUrl(url)) {
      window.postMessage(
        {
          source: "GPTExport",
          type: "GPTEXPORT_API_ERROR",
          requestId,
          error: "Invalid conversation API URL",
        },
        "*",
      );

      return;
    }

    /*
     * -------------------------------------------------
     * PERFORM AUTHENTICATED REQUEST
     * -------------------------------------------------
     */

    void (async () => {
      try {
        /*
         * We need to have observed at least one
         * authenticated ChatGPT conversation request.
         */
        if (!authenticatedHeaders) {
          throw new Error(
            "ChatGPT authentication context has not been observed yet. Open or reload the conversation and try again.",
          );
        }

        /*
         * Create a copy so we don't modify the
         * captured Headers object.
         */
        const headers = new Headers(authenticatedHeaders);

        console.log("GPTExport bridge: requesting", url);

        /*
         * Use the original fetch function.
         *
         * Authentication headers are supplied from
         * the authenticated ChatGPT request observed
         * above.
         */
        const response = await originalFetch(url, {
          method: "GET",
          credentials: "include",
          headers,
        });

        console.log("GPTExport bridge: API response", response.status);

        if (!response.ok) {
          throw new Error(
            `ChatGPT API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const data = await response.json();

        /*
         * Send JSON back to content.ts.
         */
        window.postMessage(
          {
            source: "GPTExport",
            type: "GPTEXPORT_API_RESPONSE",
            requestId,
            data,
          },
          "*",
        );
      } catch (error) {
        console.error("GPTExport bridge: API request failed", error);

        window.postMessage(
          {
            source: "GPTExport",
            type: "GPTEXPORT_API_ERROR",
            requestId,
            error: error instanceof Error ? error.message : String(error),
          },
          "*",
        );
      }
    })();
  });

  /*
   * ---------------------------------------------------------
   * BRIDGE READY
   * ---------------------------------------------------------
   *
   * content.ts listens for this message.
   */

  window.postMessage(
    {
      source: "GPTExport",
      type: "BRIDGE_READY",
    },
    "*",
  );

  console.log("GPTExport bridge: installed");
})();
