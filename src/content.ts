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
        ".text-message"
    );

    for (const element of userMessages) {
        const content = element
            .querySelector(".user-message-bubble-color")
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

function logVisibleMessages(): void {
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

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * ---------------------------------------------------------
 * QUIET-PERIOD WAIT (FAST PATH)
 * ---------------------------------------------------------
 *
 * Resolves as soon as `target` has gone quietMs without any
 * child/subtree mutation, or after maxMs regardless. Unlike
 * waitForHeightChange (which always waits for a change or
 * times out at the full maxMs), this returns quickly when
 * nothing is happening - which is the common case for most
 * scroll steps, since they usually just scroll into content
 * that's already mounted. Only genuinely slow renders (new
 * batch loading, background tab throttling) end up using
 * more of the maxMs budget.
 */
function waitForQuiet(
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
         * Start the quiet timer immediately too, in case
         * no mutation happens at all (nothing new to
         * render for this step).
         */
        settleTimer = setTimeout(finish, quietMs);

        const hardTimer = setTimeout(finish, maxMs);
    });
}

/*
 * ---------------------------------------------------------
 * POLLING WAIT (BACKGROUND-TAB SAFE)
 * ---------------------------------------------------------
 *
 * A single fixed wait(1000) is not reliable when the
 * ChatGPT tab is in the background: Chrome throttles both
 * timers AND rendering work in background tabs, so the same
 * 1000ms that's plenty of time in the foreground can pass
 * with the page not having actually re-rendered yet.
 * Confirmed by testing: the exact same scroll-to-bottom
 * step that reliably collected all 12 messages in the
 * foreground collected only 5 when the tab was in the
 * background, because scrollHeight never grew during the
 * fixed wait window.
 *
 * Instead of waiting a flat amount of time, poll scrollHeight
 * at short intervals and return as soon as it changes (or as
 * soon as maxMs is reached as a safety cap). This adapts to
 * however long the background tab actually needs, rather
 * than gambling on a single guess.
 */
async function waitForHeightChange(
    element: HTMLElement,
    startingHeight: number,
    maxMs: number
): Promise<number> {
    const pollIntervalMs = 150;
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
        await wait(pollIntervalMs);

        if (element.scrollHeight !== startingHeight) {
            /*
             * Height changed - give it one more short beat
             * to finish settling (e.g. images/markdown
             * still laying out) before returning.
             */
            await wait(pollIntervalMs);

            return element.scrollHeight;
        }
    }

    return element.scrollHeight;
}

/*
 * ---------------------------------------------------------
 * SCROLL HELPER
 * ---------------------------------------------------------
 *
 * Changing scrollTop alone is not reliable enough with
 * ChatGPT's virtualized conversation.
 *
 * ChatGPT's renderer reacts to actual scroll events.
 *
 * Therefore every programmatic scroll also dispatches
 * an explicit scroll event.
 */
function scrollAndDispatch(
    element: HTMLElement,
    top: number
): void {
    element.scrollTop = Math.max(0, top);

    element.dispatchEvent(
        new Event("scroll", {
            bubbles: true
        })
    );
}

/*
 * ---------------------------------------------------------
 * LOAD ENTIRE CONVERSATION
 * ---------------------------------------------------------
 */
async function loadEntireConversation(): Promise<Message[]> {
    const collected = new Map<string, Message>();

    const scrollContainer = document.querySelector<HTMLElement>(
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
     * -----------------------------------------------------
     * USER MESSAGE IDs
     * -----------------------------------------------------
     *
     * ChatGPT currently does not expose a stable
     * data-message-id for user messages.
     *
     * WeakMap gives every DOM element a stable ID while
     * that element exists.
     */
    let userCounter = 0;

    const userIds =
        new WeakMap<Element, string>();

    /*
     * -----------------------------------------------------
     * MESSAGE ELEMENTS
     * -----------------------------------------------------
     */
    function getMessageElements(): Element[] {
        return Array.from(
            document.querySelectorAll(
                '[data-message-author-role="assistant"], .text-message'
            )
        );
    }

    /*
     * -----------------------------------------------------
     * MESSAGE ID
     * -----------------------------------------------------
     */
    function getMessageId(
        element: Element
    ): string | null {
        const assistantId =
            element.getAttribute(
                "data-message-id"
            );

        if (assistantId) {
            return assistantId;
        }

        if (!userIds.has(element)) {
            userIds.set(
                element,
                `user-${userCounter++}`
            );
        }

        return userIds.get(element) ?? null;
    }

    /*
     * -----------------------------------------------------
     * MESSAGE EXTRACTION
     * -----------------------------------------------------
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

        const id =
            getMessageId(element);

        if (!id) {
            return null;
        }

        let content:
            | string
            | undefined;

        if (isAssistant) {
            content =
                element
                    .querySelector(".markdown")
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

        return {
            id,
            role,
            content,
            order: 0
        };
    }

    /*
     * -----------------------------------------------------
     * ORDERING RELATIONSHIPS
     * -----------------------------------------------------
     *
     * For every visible batch:
     *
     * A B C
     *
     * we record:
     *
     * A -> B
     * A -> C
     * B -> C
     *
     * This allows the final conversation order to be
     * reconstructed after virtualization.
     */
    const before =
        new Map<string, Set<string>>();

    /*
     * -----------------------------------------------------
     * COLLECT CURRENT DOM
     * -----------------------------------------------------
     */
    function collectVisibleMessages(): {
        message: Message;
        element: Element;
        top: number;
    }[] {
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

            if (!collected.has(message.id)) {
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
         * Sort by actual vertical position.
         */
        visible.sort(
            (a, b) =>
                a.top - b.top
        );

        /*
         * Record ordering relationships.
         */
        for (
            let i = 0;
            i < visible.length;
            i++
        ) {
            const currentId =
                visible[i].message.id;

            if (!before.has(currentId)) {
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
                    visible[j].message.id;

                before
                    .get(currentId)!
                    .add(followingId);
            }
        }

        return visible;
    }

    /*
     * -----------------------------------------------------
     * SCROLL TO BOTTOM FIRST
     * -----------------------------------------------------
     *
     * If the user has manually scrolled the page (up to an
     * older point, or anywhere that isn't the very bottom)
     * before clicking Copy/Export, the upward scroll loop
     * below would start from that arbitrary position and
     * only ever collect messages between there and the top -
     * silently missing everything below it, including the
     * newest messages. Confirmed by testing: scrolling
     * manually to the middle of a 12-message conversation
     * before exporting produced only 6 collected messages,
     * exactly the ones between the manual scroll position
     * and the top.
     *
     * Forcing scrollTop to the max first (with a dispatched
     * scroll event, same as every other programmatic scroll
     * in this file - see scrollAndDispatch) guarantees the
     * upward pass always starts from the true end of the
     * conversation, regardless of where the user's own
     * scrolling left the page.
     */
    const heightBeforeBottomScroll =
        scrollContainer.scrollHeight;

    scrollAndDispatch(
        scrollContainer,
        scrollContainer.scrollHeight
    );

    /*
     * Poll instead of a fixed wait - see
     * waitForHeightChange for why this matters
     * specifically for background tabs. 5000ms cap is
     * generous since this only runs once per export.
     */
    await waitForHeightChange(
        scrollContainer,
        heightBeforeBottomScroll,
        2500
    );

    /*
     * -----------------------------------------------------
     * INITIAL COLLECTION
     * -----------------------------------------------------
     */
    collectVisibleMessages();

    /*
     * -----------------------------------------------------
     * SCROLL STATE
     * -----------------------------------------------------
     */
    ;

    let previousScrollHeight =
        scrollContainer.scrollHeight;

    let stableTopIterations = 0;

    /*
     * Maximum iterations is deliberately generous.
     *
     * This is important for very long conversations where
     * ChatGPT may render many virtualized batches.
     */
    const MAX_ITERATIONS = 250;

    /*
     * Number of consecutive checks required before we
     * decide that there really are no more older messages.
     */
    const REQUIRED_STABLE_ROUNDS = 3;

    /*
     * -----------------------------------------------------
     * MAIN SCROLL LOOP
     * -----------------------------------------------------
     */
    for (
        let iteration = 0;
        iteration < MAX_ITERATIONS;
        iteration++
    ) {
        const currentScrollTop =
            scrollContainer.scrollTop;

        const currentScrollHeight =
            scrollContainer.scrollHeight;

        const visible =
            collectVisibleMessages();

        console.log(
            `GPTExport: iteration ${iteration}, ` +
            `scrollTop=${currentScrollTop}, ` +
            `scrollHeight=${currentScrollHeight}, ` +
            `visible=${visible.length}, ` +
            `collected=${collected.size}`
        );

        /*
         * -------------------------------------------------
         * TOP / VIRTUALIZATION BOUNDARY
         * -------------------------------------------------
         *
         * scrollTop === 0 does NOT necessarily mean that
         * the whole conversation is loaded.
         *
         * It can mean that ChatGPT has reached the top of
         * the currently mounted virtualized batch.
         *
         * Therefore we force a small movement and dispatch
         * a real scroll event.
         */
        if (currentScrollTop <= 5) {
            console.log(
                "GPTExport: current render boundary reached"
            );

            const heightBefore =
                scrollContainer.scrollHeight;

            const collectedBefore =
                collected.size;

            /*
             * Nudge away from zero.
             */
            scrollAndDispatch(
                scrollContainer,
                40
            );

            await wait(150);

            /*
             * Return to zero and dispatch another event.
             */
            scrollAndDispatch(
                scrollContainer,
                0
            );

            const heightBeforeNudge =
                scrollContainer.scrollHeight;

            /*
             * Give ChatGPT's React renderer time to:
             *
             * - process the scroll event
             * - mount older messages
             * - change scrollHeight
             * - perform scroll anchoring
             *
             * Polling instead of a fixed wait matters
             * most right here: this check decides whether
             * we conclude the conversation is fully
             * loaded. A background-throttled render that
             * simply needs more time must not be
             * mistaken for "nothing more to load" -
             * confirmed by testing that a fixed 1200ms
             * wait was sometimes too short in a
             * background tab, causing the loop to stop
             * with only a fraction of the conversation
             * collected.
             */
            await waitForHeightChange(
                scrollContainer,
                heightBeforeNudge,
                2000
            );

            /*
             * Collect anything that appeared.
             */
            collectVisibleMessages();

            const heightAfter =
                scrollContainer.scrollHeight;

            const collectedAfter =
                collected.size;

            const heightChanged =
                heightAfter >
                heightBefore + 10;

            const messagesChanged =
                collectedAfter >
                collectedBefore;

            console.log(
                "GPTExport: boundary result",
                {
                    heightBefore,
                    heightAfter,
                    heightChanged,
                    collectedBefore,
                    collectedAfter,
                    messagesChanged,
                    scrollTop:
                        scrollContainer.scrollTop
                }
            );

            /*
             * -------------------------------------------------
             * NEW BATCH WAS RENDERED
             * -------------------------------------------------
             *
             * This is the critical case.
             *
             * If scrollHeight increased, ChatGPT mounted
             * another portion of the conversation.
             *
             * DO NOT terminate.
             */
            if (
                heightChanged ||
                messagesChanged
            ) {
                console.log(
                    "GPTExport: older batch rendered, continuing"
                );

                stableTopIterations = 0;

                

                previousScrollHeight =
                    heightAfter;

                continue;
            }

            /*
             * -------------------------------------------------
             * NOTHING CHANGED
             * -------------------------------------------------
             *
             * We only start counting stable rounds if:
             *
             * - scrollTop is still at/near zero
             * - scrollHeight did not grow
             * - collected message count did not grow
             */
            if (
                scrollContainer.scrollTop <= 5 &&
                heightAfter <=
                    heightBefore + 10 &&
                collectedAfter ===
                    collectedBefore
            ) {
                stableTopIterations++;

                console.log(
                    `GPTExport: stable top round ` +
                    `${stableTopIterations}/${REQUIRED_STABLE_ROUNDS}`
                );
            } else {
                stableTopIterations = 0;
            }

            /*
             * Only after several completely stable rounds
             * do we conclude that we have reached the actual
             * beginning of the conversation.
             */
            if (
                stableTopIterations >=
                REQUIRED_STABLE_ROUNDS
            ) {
                console.log(
                    "GPTExport: conversation beginning confirmed"
                );

                break;
            }

            /*
             * Continue the loop.
             */
            

            previousScrollHeight =
                heightAfter;

            continue;
        }

        /*
         * -----------------------------------------------------
         * NORMAL SCROLL UP
         * -----------------------------------------------------
         */
        const scrollAmount =
            scrollContainer.clientHeight *
            0.65;

        const nextScrollTop =
            Math.max(
                0,
                currentScrollTop -
                    scrollAmount
            );

        console.log(
            "GPTExport: scrolling",
            {
                from:
                    currentScrollTop,
                to:
                    nextScrollTop
            }
        );

        /*
         * Use helper instead of assigning scrollTop
         * directly.
         */
        scrollAndDispatch(
            scrollContainer,
            nextScrollTop
        );

        /*
         * Wait for React / virtualization, but adaptively
         * instead of a flat delay. Most scroll steps just
         * reveal content that's already mounted (fast -
         * settles in well under 200ms), while occasional
         * steps trigger an actual batch load (slower,
         * especially in a background tab). A flat wait
         * long enough for the slow case makes every single
         * step pay the slow-case cost, which is what made
         * a 12-message conversation take way too long.
         * waitForQuiet resolves as soon as the DOM stops
         * changing for quietMs, so fast steps finish fast
         * and only genuinely slow steps use more of the
         * maxMs budget.
         */
        await waitForQuiet(
            scrollContainer,
            120,
            1800
        );

        /*
         * Collect after render.
         */
        collectVisibleMessages();

        /*
         * -----------------------------------------------------
         * DETECT RENDER-INDUCED JUMPS
         * -----------------------------------------------------
         *
         * ChatGPT may change scrollTop after inserting
         * older messages because of scroll anchoring.
         *
         * That is expected.
         *
         * We DO NOT treat a jump as an error.
         */
        const afterScrollTop =
            scrollContainer.scrollTop;

        const afterScrollHeight =
            scrollContainer.scrollHeight;

        if (
            Math.abs(
                afterScrollTop -
                    nextScrollTop
            ) > 500
        ) {
            console.log(
                "GPTExport: virtualization adjusted scroll position",
                {
                    requested:
                        nextScrollTop,
                    actual:
                        afterScrollTop,
                    scrollHeight:
                        afterScrollHeight
                }
            );
        }

        /*
         * -----------------------------------------------------
         * RENDER HEIGHT CHANGE
         * -----------------------------------------------------
         */
        if (
            afterScrollHeight !==
            previousScrollHeight
        ) {
            console.log(
                "GPTExport: scrollHeight changed",
                {
                    previous:
                        previousScrollHeight,
                    current:
                        afterScrollHeight
                }
            );
        }


        previousScrollHeight =
            afterScrollHeight;

        /*
         * Reset top stability because we are actively
         * moving through the conversation.
         */
        stableTopIterations = 0;
    }

    /*
     * -----------------------------------------------------
     * FINAL COLLECTION
     * -----------------------------------------------------
     */
    await wait(1500);

    collectVisibleMessages();

    const messages =
        Array.from(
            collected.values()
        );

    console.log(
        `GPTExport: collected ${messages.length} unique messages`
    );

    /*
     * -----------------------------------------------------
     * TOPOLOGICAL SORT
     * -----------------------------------------------------
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
                (incoming.get(followingId) ?? 0) + 1
            );
        }
    }

    /*
     * Start with messages that have no predecessors.
     */
    const queue: string[] = [];

    for (const message of messages) {
        if (
            (incoming.get(message.id) ?? 0) === 0
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
                (incoming.get(followingId) ?? 0) - 1;

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
     * -----------------------------------------------------
     * BUILD FINAL ARRAY
     * -----------------------------------------------------
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

    const orderedMessages: Message[] = [];

    for (
        const id of orderedIds
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
     * -----------------------------------------------------
     * SAFETY FALLBACK
     * -----------------------------------------------------
     */
    if (
        orderedMessages.length !==
        messages.length
    ) {
        console.warn(
            "GPTExport: topological sort did not include all messages"
        );

        for (
            const message of messages
        ) {
            if (
                !orderedMessages.some(
                    existing =>
                        existing.id ===
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
     * -----------------------------------------------------
     * NORMALIZE ORDER
     * -----------------------------------------------------
     */
    orderedMessages.forEach(
        (message, index) => {
            message.order =
                index;
        }
    );

    /*
     * -----------------------------------------------------
     * FINAL LOG
     * -----------------------------------------------------
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
        "GPTExport: final messages",
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
/*
 * ---------------------------------------------------------
 * CONCURRENCY GUARD
 * ---------------------------------------------------------
 *
 * loadEntireConversation() scrolls the live page and reads
 * DOM positions (getBoundingClientRect) to reconstruct
 * message order. If a second LOAD_CONVERSATION message
 * arrives while a run is still in progress - e.g. the popup
 * gets clicked more than once, or a background/throttled
 * tab is slow to respond so the popup retries - a second
 * run starts scrolling and collecting against the SAME DOM
 * at the same time. The two runs' snapshots interleave
 * randomly, which is exactly what produced results where
 * every message had "order: 0": the topological sort ran
 * against a "before" graph built from two different runs'
 * positions, which is meaningless.
 *
 * Instead of letting a second call start a second scroll
 * pass, any LOAD_CONVERSATION that arrives while a run is
 * already in flight just awaits and returns the SAME
 * in-progress result. This guarantees only one
 * loadEntireConversation() ever touches the DOM at a time,
 * regardless of how many times the message fires.
 */
let inFlightLoad: Promise<Message[]> | null = null;

function loadEntireConversationSingleFlight(): Promise<Message[]> {
    if (inFlightLoad) {
        console.log(
            "GPTExport: LOAD_CONVERSATION already in " +
            "progress, reusing existing run instead of " +
            "starting a second one"
        );

        return inFlightLoad;
    }

    const run = loadEntireConversation().finally(() => {
        /*
         * Only clear the slot if we're still the current
         * run (defensive; in practice always true since
         * this is single-threaded JS, but keeps intent
         * explicit).
         */
        if (inFlightLoad === run) {
            inFlightLoad = null;
        }
    });

    inFlightLoad = run;

    return run;
}

chrome.runtime.onMessage.addListener(
    (
        message: {
            type: string;
        },
        _sender,
        sendResponse
    ) => {
        if (
            message.type !==
            "LOAD_CONVERSATION"
        ) {
            return;
        }

        console.log(
            "GPTExport: LOAD_CONVERSATION received"
        );

        loadEntireConversationSingleFlight()
            .then(result => {
                console.log(
                    "GPTExport: sending conversation",
                    result
                );

                sendResponse({
                    success: true,
                    data: result
                });
            })
            .catch(error => {
                console.error(
                    "GPTExport: failed to load conversation",
                    error
                );

                sendResponse({
                    success: false,
                    error: String(error)
                });
            });

        /*
         * Keep the Chrome message channel open while
         * loadEntireConversation() is awaiting.
         */
        return true;
    }
);
