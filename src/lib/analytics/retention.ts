import 'server-only'
import { sql } from 'drizzle-orm'
import { env } from '@/env'
import { db } from '@/lib/db'
import { analyticsDaily, analyticsEvents } from '@/lib/db/schema'
import { addDays, dayEnd, dayStart, daysFromRows, utcDay } from './day'

/**
 * Raw-event retention.
 *
 * Raw events are the *only* copy of a day until that day has been rolled into
 * `analytics_daily`. Deleting an unaggregated day destroys it for good: the
 * events are gone, so no later run can rebuild the day, and the dashboard simply
 * loses it. That is why pruning asks the daily table about every day it is about
 * to touch, and why it refuses per day rather than all at once — a single day
 * that the aggregator has not reached must not stop the days behind it from
 * being pruned, and must not be taken along with them.
 *
 * Deletion is per whole day, not by timestamp alone. A day is the unit the
 * aggregator and the retention check both reason about, and a half-deleted day
 * is one neither of them can make sense of.
 */

export interface PruneResult {
  /** Raw events deleted by this run. */
  deleted: number
  /**
   * Days past the cutoff that were left alone because `analytics_daily` has no
   * row for them yet — the days whose only copy is still the raw events.
   *
   * They are returned rather than logged from here because the fix belongs to
   * the caller: aggregate those days, then prune again. The worker should treat
   * a non-empty list as "aggregation is behind", not as a failure of this run.
   */
  withheldDays: string[]
}

/**
 * Split the days past the cutoff into the ones that are safe to delete and the
 * ones that are not.
 *
 * A day is safe exactly when the daily table already holds it. Nothing else is
 * consulted: whether the daily row is *complete* is not knowable from here, and
 * the aggregator writes a day inside one transaction, so a day either has rows
 * or has none.
 */
export function partitionPrunableDays(
  eventDays: readonly string[],
  aggregatedDays: Iterable<string>,
): { prunable: string[]; withheld: string[] } {
  const aggregated = new Set(aggregatedDays)
  const prunable: string[] = []
  const withheld: string[] = []

  for (const day of [...eventDays].sort()) {
    if (aggregated.has(day)) prunable.push(day)
    else withheld.push(day)
  }

  return { prunable, withheld }
}

/**
 * Delete raw events older than `ANALYTICS_RAW_RETENTION_DAYS`, minus any day the
 * daily table has not seen yet.
 *
 * The cutoff is midnight UTC that many days back, so the oldest day that
 * survives is exactly that old and no day is split in half.
 *
 * Nothing here reads or writes an address: this module only ever sees a day.
 */
export async function pruneRawEvents(
  now: Date = new Date(),
): Promise<PruneResult> {
  const cutoffDay = addDays(utcDay(now), -env.ANALYTICS_RAW_RETENTION_DAYS)
  const cutoff = dayStart(cutoffDay).toISOString()

  // Every event before the cutoff, by day. Ordering is for readability of the
  // returned list; the range is what `analytics_events_created_idx` answers.
  const eventDayRows = await db.execute(sql`
    select distinct to_char(
      ${analyticsEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD'
    ) as day
    from ${analyticsEvents}
    where ${analyticsEvents.createdAt} < ${cutoff}
    order by 1
  `)

  const aggregatedRows = await db.execute(sql`
    select distinct to_char(${analyticsDaily.day}, 'YYYY-MM-DD') as day
    from ${analyticsDaily}
    where ${analyticsDaily.day} < ${cutoffDay}
    order by 1
  `)

  const { prunable, withheld } = partitionPrunableDays(
    daysFromRows(eventDayRows.rows),
    daysFromRows(aggregatedRows.rows),
  )

  let deleted = 0

  for (const day of prunable) {
    // Every day in `prunable` is a day of events that all fall before the
    // cutoff, so the day's own bounds already sit inside the window and the
    // delete needs no second timestamp test. Deleting a day at a time is also
    // what makes the withheld days structurally unreachable: they are simply
    // not in the list.
    const result = await db.execute(sql`
      delete from ${analyticsEvents}
      where ${analyticsEvents.createdAt} >= ${dayStart(day).toISOString()}
        and ${analyticsEvents.createdAt} < ${dayEnd(day).toISOString()}
    `)
    deleted += result.rowCount ?? 0
  }

  return { deleted, withheldDays: withheld }
}
