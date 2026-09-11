/**
 * How long a page was on screen, counted by the only party that knows.
 *
 * A separate module from the component that uses it, and deliberately free of
 * the DOM: this is arithmetic with an ordering to it — visible, hidden, maybe
 * visible again, reported exactly once — and arithmetic is what a test can
 * pin down. A component that owns a `document` listener can only be tested by
 * driving a browser, which means it is not tested.
 *
 * No `server-only` marker, and none may be added: this file is imported by a
 * client component.
 *
 * ## Why "visible" and not "loaded"
 *
 * The interesting number is not how long the page existed but how long someone
 * could have been reading it. A tab opened in the background, a phone locked
 * mid-article and a browser restored on start-up all have a lifetime that has
 * nothing to do with attention, and counting them would make every duration on
 * the dashboard an overstatement of a quantity that is already only a proxy.
 */

/**
 * Accumulates visible milliseconds, and decides who gets to report them.
 *
 * The clock takes its time from a function rather than reading a global, so a
 * test can move it. `Date.now()` is the default because the alternative,
 * `performance.now()`, is not guaranteed to exist in every environment this
 * module is imported into — and the difference between the two does not matter
 * for a number that is rounded to the second by the time anyone reads it.
 */
export class DwellClock {
  private visibleSince: number | null = null
  private accumulatedMs = 0
  private reported = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The page is on screen. Repeated calls are not a second stretch of time. */
  show(): void {
    if (this.visibleSince === null) this.visibleSince = this.now()
  }

  /**
   * The page is no longer on screen.
   *
   * The time since `show()` is banked rather than discarded, so a reader who
   * switches tabs and comes back is credited with both stretches.
   */
  hide(): void {
    if (this.visibleSince === null) return
    this.accumulatedMs += Math.max(0, this.now() - this.visibleSince)
    this.visibleSince = null
  }

  /**
   * Visible milliseconds so far, including the stretch still in progress.
   *
   * Clamped at zero: a clock that steps backwards — an NTP correction, a device
   * waking from suspend — must not produce a negative duration, which the
   * server's schema rejects and would therefore cost the whole view rather than
   * one field of it.
   */
  elapsedMs(): number {
    const running = this.visibleSince === null ? 0 : Math.max(0, this.now() - this.visibleSince)
    return this.accumulatedMs + running
  }

  get isReported(): boolean {
    return this.reported
  }

  /**
   * Claim the right to report this view, once.
   *
   * A beacon is a page view: the server writes one row per request and does not
   * try to recognise a repeat, because recognising it would mean keeping
   * something about the reader to recognise them with. So "exactly one beacon
   * per view" is not a nicety — it is the only thing standing between this
   * client and a view count that doubles whenever a page is hidden and shown
   * again, which on mobile is every time the reader switches apps.
   */
  claim(): boolean {
    if (this.reported) return false
    this.reported = true
    return true
  }
}
