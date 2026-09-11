/**
 * What the browser sends, and what the server accepts — written once.
 *
 * ## Why this file exists separately from `collect.ts`
 *
 * The beacon is the one place in this project where two programs that are built
 * separately have to agree on a shape: a page view is reported by whatever
 * bundle the reader's browser happens to have cached, and accepted by whatever
 * version of the server is running now. `beaconSchema` in `collect.ts` is the
 * authority — it decides — but the client cannot import it: that module is
 * `server-only`, and importing zod into a page's bundle to validate a payload
 * the client itself just built would cost every reader a parser for a format
 * only the client writes.
 *
 * So the shape lives here, with no dependencies at all, and both sides import
 * it: the client for the type and the limits it must respect, the server for
 * the limits it enforces. This file has no `server-only` marker and must never
 * acquire one.
 *
 * ## Why the fields are what they are
 *
 * Everything a client could be tempted to report is absent. There is no path —
 * the server reads it from the request, because a client that could name the
 * page could name someone else's. There is no identifier of any kind. What is
 * left is three optional fields, each of which the client is the only honest
 * source of, and each of which the server treats as a claim rather than a fact.
 */

/**
 * How the reader arrived at this page.
 *
 * Exactly the four values `PerformanceNavigationTiming.type` can hold, so the
 * browser's own vocabulary is the vocabulary here. A client-side navigation
 * within the site is none of the four and reports nothing: the array of
 * arrivals this field can describe has no word for "clicked a link in a
 * single-page app", and inventing one would mean the server has to guess what
 * it meant.
 */
export const NAVIGATION_TYPES = ['navigate', 'reload', 'back_forward', 'prerender'] as const

export type NavigationType = (typeof NAVIGATION_TYPES)[number]

/**
 * A referrer longer than this is not a referrer.
 *
 * Matches the column the server stores it in and the limit its schema enforces.
 * The client truncates to it rather than sending something longer: an
 * over-length field fails the schema, and a failed schema drops the whole
 * beacon — the view would be lost, not merely the referrer. Truncation keeps
 * the part that is kept anyway, since only the host survives collection.
 */
export const MAX_REFERRER_LENGTH = 2048

/**
 * One day: a page cannot claim a reader stayed longer than the reader has
 * existed.
 *
 * A tab left open overnight would otherwise report a duration the schema
 * refuses, losing the view. The client clamps to this bound before sending.
 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000

/** The beacon payload, as the client writes it and the server expects it. */
export interface BeaconPayload {
  /** `document.referrer`: the page that linked here, if any. */
  referrer?: string
  /** Milliseconds the page was visible. A claim, never trusted. */
  durationMs?: number
  /** How the reader arrived. Absent for a navigation within the site. */
  navigationType?: NavigationType
}

/** Whole milliseconds, non-negative and bounded. */
export function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  return Math.min(Math.round(durationMs), MAX_DURATION_MS)
}

/**
 * Build the payload for one page view.
 *
 * Absent rather than empty, everywhere a field can be absent: a direct visit has
 * no referrer, and the schema's version of "no referrer" is a missing key, not a
 * zero-length string. The two are different on the wire, and only one of them
 * matches what the server will accept.
 */
export function buildBeacon(input: {
  referrer?: string | null
  durationMs?: number
  navigationType?: NavigationType | undefined
}): BeaconPayload {
  const payload: BeaconPayload = { durationMs: clampDuration(input.durationMs ?? 0) }

  const referrer = input.referrer?.trim()
  if (referrer) payload.referrer = referrer.slice(0, MAX_REFERRER_LENGTH)

  if (input.navigationType) payload.navigationType = input.navigationType

  return payload
}
