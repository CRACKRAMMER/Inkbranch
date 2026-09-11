/**
 * Day arithmetic for the analytics tables.
 *
 * Every boundary here is a UTC day. `analytics_daily.day` is a `date`, and the
 * roll-up, the retention cutoff and the dashboard ranges all have to agree on
 * where one day ends — a boundary drawn in the reader's timezone would put the
 * same event on two different days depending on which query asked. The site's
 * configured timezone is deliberately not consulted, because events are stored
 * as `timestamptz`: UTC is the only reading of `created_at` that does not depend
 * on the server's locale.
 *
 * These helpers exist because of one trap in the driver, too. A Postgres `date`
 * arrives as a JavaScript `Date` at the *server's* local midnight, so reading
 * `day` through the column mapper and formatting it gives the previous day
 * everywhere west of UTC. Reads therefore select `to_char(day, 'YYYY-MM-DD')`,
 * and writes pass the `YYYY-MM-DD` string through untouched.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The UTC day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10)
}

/**
 * True when `value` is a day that exists.
 *
 * The pattern alone accepts `2026-02-31`, which `Date` rolls forward into March
 * without complaint, so the parse is round-tripped rather than trusted.
 */
export function isDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

/** Midnight UTC at the start of `day`. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Midnight UTC at the start of the day *after* `day` — an exclusive bound. */
export function dayEnd(day: string): Date {
  return new Date(dayStart(day).getTime() + MS_PER_DAY)
}

/** `day` shifted by whole days; negative moves backwards. */
export function addDays(day: string, days: number): string {
  return utcDay(new Date(dayStart(day).getTime() + days * MS_PER_DAY))
}

/** Every day from `from` to `to`, inclusive. Empty when `from` is after `to`. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  const last = dayStart(to).getTime()

  for (let at = dayStart(from).getTime(); at <= last; at += MS_PER_DAY) {
    days.push(utcDay(new Date(at)))
  }

  return days
}
