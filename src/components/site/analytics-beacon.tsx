'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

import { buildBeacon, NAVIGATION_TYPES, type NavigationType } from '@/lib/analytics/beacon'
import { DwellClock } from '@/lib/analytics/dwell'
import { onLeaving } from '@/lib/analytics/leave'

/** Where beacons go. Public and unauthenticated: see the route for why. */
const ENDPOINT = '/api/analytics'

/**
 * Reports a page view, once per view, without cookies.
 *
 * ## Why this is a client component at all
 *
 * The server already sees every request, and a page view could have been counted
 * where it is served. It is not, for two reasons. A view rendered by the server
 * cannot tell a reader from a prefetch — the App Router asks for routes nobody
 * has clicked — and it cannot know how long anyone stayed. Both of those are
 * things only the browser knows, and both are things this project only asks
 * for if it is prepared to run code in the reader's browser to get them.
 *
 * What it asks for is bounded on purpose: three optional fields, no identifier,
 * no fingerprint, nothing that survives the day. The reader who wants the
 * argument in full should read `collect.ts`, which is where the rules live and
 * where the address is never read.
 *
 * ## Why it renders nothing and is mounted by the layout
 *
 * The site layout decides whether to render it, from settings and the
 * environment, and the answer is checked once there rather than on every beacon.
 * With collection off the component never mounts, so no bundle is downloaded
 * to send nothing.
 *
 * ## Why the effect is keyed on the pathname
 *
 * A client component in a layout is *not* remounted by a navigation within the
 * site — that is the point of a layout, and it is why this component cannot
 * simply report on mount. `usePathname` does change, which re-runs the effect,
 * which is what turns one long-lived component into one report per page the
 * reader actually looked at.
 *
 * ## When the report goes out
 *
 * Not when the reader arrives — a view has no duration until it ends — and not
 * when React tears the effect down either, because by then the address bar
 * holds the *next* page and the server, which reads the page from the request's
 * `Referer`, would file the view under it. The report goes out the moment the
 * reader is about to leave, while the URL still names the page being reported,
 * which is what `leave.ts` is for. The cleanup below is the fallback for the one
 * navigation those hooks cannot see.
 */
export function AnalyticsBeacon() {
  const pathname = usePathname()

  /*
   * The last path this component reported, and the guard that makes the report
   * happen once.
   *
   * Two forces would otherwise double-count. The first is React's development
   * StrictMode, which runs every effect twice — mount, cleanup, mount — against
   * the same component instance and the same refs; without this, every page
   * viewed in development would be counted twice. The second is that a view has
   * several endings — the tab is hidden, the document is unloaded, the reader
   * navigates on — and more than one of them can happen.
   *
   * A ref rather than state: it must not cause a render, and it must survive the
   * cleanup that sets it.
   */
  const reportedRef = useRef<string | null>(null)

  useEffect(() => {
    if (reportedRef.current === pathname) return
    if (typeof navigator?.sendBeacon !== 'function') return

    const clock = new DwellClock()

    /*
     * How the reader arrived, and only for the first page of the document.
     *
     * `navigationType` describes one arrival at the site; a navigation within it
     * is not one of the four the field can hold, and reporting the value from
     * the original load again would describe the second view as a reload of a
     * page that was never reloaded. The honest answer for those is to say
     * nothing, so the field is absent.
     */
    const navigationType = reportedRef.current === null ? arrivalType() : undefined

    if (document.visibilityState === 'visible') clock.show()

    const report = () => {
      if (!clock.claim()) return
      reportedRef.current = pathname

      const payload = buildBeacon({
        referrer: document.referrer,
        durationMs: clock.elapsedMs(),
        navigationType,
      })

      // `sendBeacon` rather than `fetch`: it is the one request the browser
      // promises to finish while a page is being unloaded, which is exactly when
      // the last and most interesting view of a session is reported. The
      // response is ignored — the server answers 204 because there is nothing a
      // page could do with it — so a refused beacon is a lost view and never a
      // broken page.
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      )
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      clock.hide()
      report()
    }

    /*
     * The reader is going somewhere else, which is where almost every view ends.
     *
     * This has to run before the URL changes — the beacon is reported against
     * whatever the address bar holds when it goes out — and by the time an
     * effect cleanup runs, a navigation within the site has already rewritten
     * it. `leave.ts` carries the argument in full; what matters here is that
     * this is the report that names the right page.
     */
    const stopWatchingLeaving = onLeaving(report)

    document.addEventListener('visibilitychange', onVisibilityChange)
    /*
     * A backstop, not the main path. `visibilitychange` to hidden is the last
     * event a page is reliably given, and it fires in more situations than
     * `pagehide` does; but a browser that unloads without ever firing it would
     * lose the view, and a second listener costs nothing because `report` is
     * idempotent.
     */
    window.addEventListener('pagehide', report)

    return () => {
      stopWatchingLeaving()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', report)
      /*
       * The last resort, and the only report left that can name the wrong page.
       *
       * By now React has rendered the next route, so the URL changed some time
       * ago and `onLeaving` above has already reported this view — on anything
       * but a browser whose back and forward buttons it cannot see, in which
       * case this is what counts the view. Counted one page late is better than
       * not counted, and `claim` is what keeps the two from being two.
       */
      clock.hide()
      report()
    }
  }, [pathname])

  return null
}

/**
 * The browser's own word for how this document was reached.
 *
 * `PerformanceNavigationTiming.type` is already one of the four values the
 * contract allows, so this narrows rather than maps. Anything unexpected —
 * including a browser with no navigation timing at all — reports nothing: the
 * field is optional, and a guessed value would be a claim about the reader that
 * is not true.
 */
function arrivalType(): NavigationType | undefined {
  const entry = performance.getEntriesByType('navigation')[0]
  if (!entry) return undefined

  const type = (entry as PerformanceNavigationTiming).type
  return (NAVIGATION_TYPES as readonly string[]).includes(type)
    ? (type as NavigationType)
    : undefined
}
