/**
 * Date formatting.
 *
 * Dates are formatted on the server and passed down as strings. Two reasons,
 * and both are load-bearing:
 *
 *   1. `Intl` with a time zone is a real cost to ship, and a client component
 *      that formats a date would pull the whole formatter into the bundle for
 *      every page that shows one.
 *   2. A client that formats has to hydrate — and if its locale or time zone
 *      differs from the server's, React finds different text on the two sides
 *      and the page flickers or warns. Formatting once, on the server, makes
 *      the string a value rather than a computation.
 *
 * The time zone is always explicit. It comes from `settings.timezone`, because
 * a post published at 23:30 in Shanghai is dated the 11th by its author, and
 * showing it as the 10th because the server runs in UTC is simply wrong.
 */

export type DateStyle = 'long' | 'medium' | 'short' | 'day'

const STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  /** 11 September 2026 */
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  /** 11 Sep 2026 */
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  /** 11 Sep — the form the home page's timeline reads best in */
  short: { day: 'numeric', month: 'short' },
  /** 11 */
  day: { day: 'numeric' },
}

export interface DateFormatContext {
  locale: string
  timeZone: string
}

/**
 * Format an instant for display.
 *
 * A formatter is built per call rather than memoised in a module-level `Map`.
 * `Intl.DateTimeFormat` construction is genuinely expensive, but it is being
 * built at most a few dozen times per render, on the server, where the cost is
 * microseconds against a database round trip — and a module-level cache keyed
 * by string is a memory leak that outlives every request in a long-running
 * process. If profiling ever contradicts this, the fix is a per-request cache,
 * not a global one.
 */
export function formatDate(
  date: Date | string | null | undefined,
  context: DateFormatContext,
  style: DateStyle = 'medium',
): string {
  if (!date) return ''

  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''

  return new Intl.DateTimeFormat(context.locale, {
    ...STYLE_OPTIONS[style],
    timeZone: context.timeZone,
  }).format(value)
}

/** The machine-readable form, for `<time datetime>` and for RSS. */
export function toIsoDate(date: Date | string | null | undefined): string {
  if (!date) return ''
  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''
  return value.toISOString()
}

/** The four-digit year an instant falls in, in the site's time zone. */
export function yearIn(date: Date | string, timeZone: string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''
  return new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format(value)
}

const RELATIVE_UNITS: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'year', seconds: 31536000 },
  { unit: 'month', seconds: 2592000 },
  { unit: 'week', seconds: 604800 },
  { unit: 'day', seconds: 86400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
]

/**
 * "3 days ago", for the garden's "updated recently" line.
 *
 * `now` is a parameter rather than a call to `Date.now()`, so the function is
 * pure and a test can pin the clock. Callers pass one `now` for the whole
 * render, which also keeps every relative label on a page consistent — reading
 * the clock per item can produce "1 day ago" and "2 days ago" for two items
 * updated in the same commit.
 *
 * Future dates are rendered as "in 3 days" rather than clamped: a post
 * scheduled for next week genuinely is in the future, and pretending otherwise
 * hides the schedule from the one person who set it.
 */
export function formatRelative(
  date: Date | string | null | undefined,
  context: DateFormatContext & { now: Date },
): string {
  if (!date) return ''

  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''

  const deltaSeconds = (value.getTime() - context.now.getTime()) / 1000
  const absolute = Math.abs(deltaSeconds)

  const formatter = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto' })

  for (const { unit, seconds } of RELATIVE_UNITS) {
    if (absolute >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit)
    }
  }

  return formatter.format(Math.round(deltaSeconds), 'second')
}

/**
 * Join two dates into the "Published 11 Sep, updated 3 days ago" fragment.
 *
 * A page that prints both dates unconditionally reads as noise on the majority
 * of posts, which are never edited. The update is only worth showing when it is
 * materially later than publication — a day of slack absorbs the same-edit
 * round trip where a save bumps `updatedAt` minutes after the first publish.
 */
export function revisionNote(
  publishedAt: Date | null,
  updatedAt: Date,
  context: DateFormatContext & { now: Date },
): string | null {
  if (!publishedAt) return null

  const slackMs = 24 * 60 * 60 * 1000
  if (updatedAt.getTime() - publishedAt.getTime() < slackMs) return null

  return formatRelative(updatedAt, context)
}
