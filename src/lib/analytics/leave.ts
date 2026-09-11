/**
 * When the reader is about to leave the page, while the URL still names it.
 *
 * ## Why this exists
 *
 * A beacon's contract lets the client report a view but never name it: the
 * server derives the page from the request's `Referer`, which the browser sets
 * and the client cannot forge — a client that could name the page could name
 * someone else's. That is what makes a page view worth counting, and it has one
 * consequence that is easy to miss: **the beacon has to be sent while the page
 * being reported is still the document's URL.**
 *
 * Reporting at the moment the view ends is the natural place to put it, and it
 * is exactly where it does not work. A navigation within the site sets the URL
 * with `history.pushState` *before* React re-renders, so an effect cleanup runs
 * with the next page already in the address bar: the beacon goes out with
 * `Referer: /the-next-page`, and the view just finished is recorded against the
 * page the reader moved to. The total stays right and every per-page number is
 * wrong — which is the failure mode a dashboard cannot show you.
 *
 * So the report belongs one moment earlier, and finding that moment is this
 * module's whole job.
 *
 * ## The two mechanisms
 *
 * No single one covers every browser, so both are used:
 *
 * - The **Navigation API** fires a `navigate` event before the URL is updated,
 *   and fires it for every kind of navigation: link clicks, back and forward,
 *   and calls the router makes itself.
 * - **`history.pushState` and `replaceState`**, wrapped. Chromium fires the
 *   event above for these anyway — the wrapper costs nothing there — but
 *   Firefox has not shipped the Navigation API, and the router still navigates
 *   by calling `pushState` directly. Without the wrapper those browsers keep
 *   exactly the misattribution this module exists to fix.
 *
 * ## What a hook is worth, and what it is not
 *
 * Not a promise that the reader left. A navigation can be cancelled, and a
 * wrapped `pushState` can be called by anything on the page. What the hooks give
 * is the earliest honest signal available, and the caller has to treat it that
 * way — the report is built and sent *synchronously* inside the handler, because
 * anything deferred would run after the URL had changed and be wrong again.
 * `DwellClock.claim()` is what still guarantees a view is reported once, so a
 * hook that fires twice, or fires and turns out to be wrong, costs a number
 * rather than a duplicate.
 *
 * ## What is left uncovered
 *
 * Back and forward on a browser with neither mechanism — Firefox today. Those
 * views are still reported, by the caller's own cleanup, one page late: counted,
 * attributed to the wrong page. That is the behaviour every browser had before
 * this module.
 *
 * ## Why there is no unit test here
 *
 * The module is two listeners on two browser interfaces and has no logic that
 * does not depend on them being real. `tests/e2e/analytics.spec.ts` drives it in
 * a browser, which is the only place the question it answers — is the report
 * sent while the old URL is still current? — can be asked.
 *
 * No `server-only` marker, and none may be added: this file is imported by a
 * client component.
 */

/** Called when the reader is about to leave the page on screen. */
export type LeavingHandler = () => void

/**
 * The Navigation API's `navigate` event, as much of it as is used here.
 *
 * Written out rather than imported because TypeScript's DOM library does not
 * declare the Navigation API at all — this is one of the places where the
 * platform is ahead of the types.
 */
interface NavigateEventLike {
  destination?: { url?: string }
}

/** The Navigation API entry point, as much of it as is used here. */
interface NavigationLike {
  addEventListener(type: 'navigate', listener: (event: Event) => void): void
  removeEventListener(type: 'navigate', listener: (event: Event) => void): void
}

/**
 * The Navigation API, if this browser has one.
 *
 * Absent in Firefox, which is why every use of it is optional. Read through an
 * `unknown` cast because the type it would be cast from does not exist yet.
 */
function navigationApi(): NavigationLike | undefined {
  return (window as unknown as { navigation?: NavigationLike }).navigation
}

/**
 * Whether `url` names the page already on screen.
 *
 * Compares the origin and the path, and deliberately not the query or the
 * fragment: a page is one view whatever is in its search string, and an in-page
 * anchor or a rewritten query is not somewhere the reader went. It is also what
 * keeps the router's own `replaceState` on load — which republishes the URL that
 * is already there — from ending a view that has not begun.
 *
 * An unparseable URL counts as the same page, so the answer to "is this a
 * navigation?" defaults to no. The caller runs inside the router's own call
 * stack: throwing here would not lose a page view, it would break the
 * navigation.
 */
function isSamePage(url: string, currentHref: string): boolean {
  try {
    const next = new URL(url, currentHref)
    const current = new URL(currentHref)
    return next.origin === current.origin && next.pathname === current.pathname
  } catch {
    return true
  }
}

/**
 * Call `handler` when a navigation is about to change which page is on screen.
 *
 * Returns the undo. Callers register it per page and run it on the way out, so
 * that whatever is listening belongs to the page the reader is actually on.
 */
export function onLeaving(handler: LeavingHandler): () => void {
  const undo: Array<() => void> = []

  const navigation = navigationApi()
  if (navigation) {
    const listener = (event: Event) => {
      const destination = (event as NavigateEventLike).destination?.url
      if (!destination || isSamePage(destination, location.href)) return
      handler()
    }
    navigation.addEventListener('navigate', listener)
    undo.push(() => navigation.removeEventListener('navigate', listener))
  }

  // Registered whether or not the Navigation API exists: on Chromium and Safari
  // it is a second report for a navigation the event already reported, and
  // `claim()` drops it. Cheaper than a branch that would be wrong if a browser
  // ever gained one mechanism and lost the other.
  undo.push(wrapHistory('pushState', handler))
  undo.push(wrapHistory('replaceState', handler))

  return () => {
    // Unwound in reverse, so a nested wrapper is restored before its wrapper.
    for (const step of undo.reverse()) step()
  }
}

/**
 * Wrap one `History` method, so that a navigation calls `handler` first.
 *
 * The URL is the third argument. It is absent from a call that only restores
 * state, which is not a navigation and is not reported on.
 */
function wrapHistory(
  name: 'pushState' | 'replaceState',
  handler: LeavingHandler,
): () => void {
  const original = history[name]
  const wrapped = function (this: History, ...args: unknown[]): void {
    const url = args[2]
    if (typeof url === 'string' && !isSamePage(url, location.href)) handler()
    ;(original as (...rest: unknown[]) => void).apply(this, args)
  } as History[typeof name]

  history[name] = wrapped

  return () => {
    // Only if nothing has wrapped it since. Restoring unconditionally would
    // discard a later wrapper and leave whatever installed it unable to clean
    // up after itself.
    if (history[name] === wrapped) history[name] = original
  }
}
