import 'server-only'
import { and, eq, gt, gte, lt, sql } from 'drizzle-orm'
import { env } from '@/env'
import { db } from '@/lib/db'
import { analyticsDaily, analyticsEvents, contentIndex, type DeviceType } from '@/lib/db/schema'
import { addDays, dayEnd, dayStart, daysFromRows, eachDay, isDay, utcDay } from './day'

/**
 * Raw events into `analytics_daily`.
 *
 * A day is *recomputed*, never incremented. The daily table is keyed by its
 * dimensions — (day, path, referrer domain, device, country) — so a day is a set
 * of rows and a re-run rebuilds the whole set from the events. That is the only
 * version that survives a retry: an incrementing roll-up doubles every counter it
 * touches the second time it runs, and the second time is the one that happens
 * after a crash. The delete and the insert commit in one transaction, so an
 * interrupted run leaves the previous rows exactly as they were.
 *
 * The arithmetic itself lives in `DayRollup` rather than in SQL, so the code the
 * tests exercise is the code that runs. The read is chunked, so a busy day costs
 * memory in proportion to its distinct visitors, not to its event count.
 */

/** Raw events are read in chunks of this many rows, keyed by primary key. */
const READ_CHUNK = 5000
/**
 * Rows per insert statement. Postgres allows 65535 bind parameters and a row
 * here is nine of them, so a day with more than seven thousand distinct
 * dimensions would otherwise fail the whole aggregate at the last statement.
 */
const INSERT_CHUNK = 1000

/** One raw event, reduced to the columns the roll-up reads. */
export interface RollupEvent {
  path: string
  contentId: string | null
  referrerDomain: string
  device: DeviceType
  country: string
  visitorHash: string
}

/** One row of `analytics_daily`, without the day. */
export interface DailyDimensionRow {
  path: string
  contentId: string | null
  referrerDomain: string
  device: DeviceType
  country: string
  views: number
  visitors: number
}

interface Bucket {
  path: string
  contentId: string | null
  referrerDomain: string
  device: DeviceType
  country: string
  views: number
  /** Distinct visitor hashes seen in this dimension tuple. */
  visitors: Set<string>
}

/**
 * The daily table's unique key, as a `Map` key.
 *
 * NUL separates the parts because it cannot occur in a path, a host or an enum
 * value. Without a separator `('ab', 'c')` and `('a', 'bc')` would collide, and
 * two dimensions would be summed into one row that describes neither.
 */
function dimensionKey(event: RollupEvent): string {
  return [
    event.path,
    event.contentId ?? '',
    event.referrerDomain,
    event.device,
    event.country,
  ].join('\u0000')
}

function compare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Events in, one day's rows out.
 *
 * The footprint is the day's distinct (dimension tuple, visitor) pairs — the
 * smallest thing an exact distinct count can be computed from. Holding the
 * events instead would mean holding every event twice a day.
 */
export class DayRollup {
  private readonly buckets = new Map<string, Bucket>()
  private eventCount = 0

  add(event: RollupEvent): void {
    const key = dimensionKey(event)
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = {
        path: event.path,
        contentId: event.contentId,
        referrerDomain: event.referrerDomain,
        device: event.device,
        country: event.country,
        views: 0,
        visitors: new Set<string>(),
      }
      this.buckets.set(key, bucket)
    }

    bucket.views += 1
    this.eventCount += 1

    // An event with no visitor cookie carries nothing to count. Counting the
    // empty hash as a visitor would invent a reader, so a row can legitimately
    // end up with views > 0 and visitors = 0.
    if (event.visitorHash) bucket.visitors.add(event.visitorHash)
  }

  get size(): number {
    return this.eventCount
  }

  /** The rows to write, in a stable order. */
  rows(): DailyDimensionRow[] {
    return [...this.buckets.values()]
      .map((bucket) => ({
        path: bucket.path,
        contentId: bucket.contentId,
        referrerDomain: bucket.referrerDomain,
        device: bucket.device,
        country: bucket.country,
        views: bucket.views,
        visitors: bucket.visitors.size,
      }))
      .sort(
        (a, b) =>
          compare(a.path, b.path) ||
          compare(a.referrerDomain, b.referrerDomain) ||
          compare(a.device, b.device) ||
          compare(a.country, b.country) ||
          compare(a.contentId ?? '', b.contentId ?? ''),
      )
  }

  /**
   * Sums of what `rows()` holds.
   *
   * `visitors` is the sum of the per-dimension unique counts, which is what the
   * table stores. It is not the number of distinct readers that day: a reader
   * who arrived on two paths is one reader and two counted visitors, and the
   * schema has nowhere to put the day-wide number.
   */
  totals(): { views: number; visitors: number } {
    let views = 0
    let visitors = 0
    for (const bucket of this.buckets.values()) {
      views += bucket.views
      visitors += bucket.visitors.size
    }
    return { views, visitors }
  }
}

export interface AggregateResult {
  day: string
  /** True when the day had no raw events, so nothing was written or removed. */
  skipped: boolean
  /** Rows now in `analytics_daily` for the day. */
  rows: number
  views: number
  visitors: number
}

/**
 * Read one day's raw events into a roll-up.
 *
 * Paged by primary key rather than loaded whole: the key is monotonic, so a
 * chunk boundary can neither skip nor repeat a row, and `analytics_events_created_idx`
 * answers the range. Events written while a day is being aggregated can land in
 * a later chunk; they cannot land in an earlier one.
 */
async function readDay(day: string): Promise<DayRollup> {
  const rollup = new DayRollup()
  const from = dayStart(day)
  const to = dayEnd(day)
  let after = 0

  for (;;) {
    const rows = await db
      .select({
        id: analyticsEvents.id,
        path: analyticsEvents.path,
        contentId: analyticsEvents.contentId,
        referrerDomain: analyticsEvents.referrerDomain,
        device: analyticsEvents.device,
        country: analyticsEvents.country,
        visitorHash: analyticsEvents.visitorHash,
      })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.createdAt, from),
          lt(analyticsEvents.createdAt, to),
          gt(analyticsEvents.id, after),
        ),
      )
      .orderBy(analyticsEvents.id)
      .limit(READ_CHUNK)

    if (rows.length === 0) break

    for (const row of rows) rollup.add(row)

    const last = rows[rows.length - 1]
    if (!last || rows.length < READ_CHUNK) break
    after = last.id
  }

  return rollup
}

/**
 * Rebuild one day of `analytics_daily` from its raw events.
 *
 * A day with no raw events is skipped, not written as a zero row. The daily
 * table is keyed by its dimensions, so a zero row would have to invent a path, a
 * referrer and a device to sit in, and every later query would have to remember
 * to exclude it — the sort of sentinel that is forgotten once and then quietly
 * becomes a page nobody read. The gap is cheaper to fill where the range is
 * already known; `getAnalyticsSummary` pads its series.
 *
 * A skipped day is also left exactly as it is. Rows can outlive their raw events
 * (retention deletes those), and rebuilding from nothing would destroy the only
 * copy of a day that was already aggregated.
 */
export async function aggregateDay(day: string): Promise<AggregateResult> {
  // A caller passing something that is not a day has a bug that must surface
  // rather than be quietly rounded into one.
  if (!isDay(day)) throw new Error(`Not a calendar day: ${day}`)

  const rollup = await readDay(day)

  if (rollup.size === 0) {
    return { day, skipped: true, rows: 0, views: 0, visitors: 0 }
  }

  const rows = rollup.rows()
  const totals = rollup.totals()

  await db.transaction(async (tx) => {
    await tx.delete(analyticsDaily).where(eq(analyticsDaily.day, day))

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx
        .insert(analyticsDaily)
        .values(rows.slice(i, i + INSERT_CHUNK).map((row) => ({ day, ...row })))
    }
  })

  return {
    day,
    skipped: false,
    rows: rows.length,
    views: totals.views,
    visitors: totals.visitors,
  }
}

/**
 * Aggregate every day in the range, oldest first.
 *
 * Sequential: every day is a transaction over the same table, and a backfill
 * that opened one connection per day would be a worse neighbour than one that
 * took slightly longer.
 */
export async function aggregateRange(
  from: string,
  to: string,
): Promise<AggregateResult[]> {
  const results: AggregateResult[] = []

  for (const day of eachDay(from, to)) {
    results.push(await aggregateDay(day))
  }

  return results
}

/* -------------------------------------------------------------------------- */
/*  Catching up                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Days one run will rebuild.
 *
 * A backlog is drained a bounded number of days at a time rather than in one
 * unbounded transaction per day, and this is the bound. It is the default
 * retention window plus a day, so the worst case an operator can reach without
 * changing a setting and losing their history — a worker that was down for
 * exactly as long as events are kept — still finishes in a single run.
 */
export const MAX_AGGREGATE_DAYS_PER_RUN = 31

export interface AggregateDaysResult {
  /** Days that had raw events and were rebuilt from them. */
  aggregated: string[]
  /** Days that had none and were left exactly as they were. */
  empty: string[]
  rows: number
  views: number
  visitors: number
}

/** Aggregate each day in the order given, summing what each one rebuilt. */
export async function aggregateDays(
  days: readonly string[],
): Promise<AggregateDaysResult> {
  const result: AggregateDaysResult = {
    aggregated: [],
    empty: [],
    rows: 0,
    views: 0,
    visitors: 0,
  }

  for (const day of days) {
    const one = await aggregateDay(day)

    if (one.skipped) {
      result.empty.push(day)
      continue
    }

    result.aggregated.push(day)
    result.rows += one.rows
    result.views += one.views
    result.visitors += one.visitors
  }

  return result
}

export interface PendingDays {
  /** The days to aggregate this run, newest two first. */
  days: string[]
  /** Days that were due but did not fit; the next run takes them. */
  deferred: string[]
}

/**
 * The days that need aggregating, derived from the tables rather than recorded.
 *
 * Two of them are always here whatever the tables say:
 *
 * - **Today**, because today is not over. Events keep arriving until midnight,
 *   so a day rolled up an hour ago is a partial day, and a dashboard that only
 *   ever rolled up a day once would show today's traffic frozen at whatever time
 *   the worker last ran.
 * - **Yesterday**, because the last event of a day can be written after the last
 *   run of that day. Midnight is not an event; nothing wakes the worker to say
 *   the day is finished.
 *
 * The rest are the holes: days inside the lookback that have raw events and no
 * row in `analytics_daily`. That is what a worker that was down for a week
 * leaves behind, and reading it out of the data means there is no checkpoint to
 * keep in step with the tables — and nothing to go wrong when a run does not
 * happen, which is the failure a checkpoint is worst at.
 *
 * ## Why the lookback is the retention window
 *
 * A day of raw events either has been pruned or is still waiting to be rolled
 * up; the two sets are complements. Looking back exactly as far as retention
 * keeps events therefore covers every day that could still need this. A shorter
 * window would strand the oldest days — retention refuses to delete a day the
 * daily table has never seen, and nothing would roll it up — which turns a
 * backup that failed into a table that grows for ever.
 */
export async function pendingDays(now: Date = new Date()): Promise<PendingDays> {
  const today = utcDay(now)
  // Not configurable on its own: the argument above is that it is exactly the
  // retention window, and a second setting is a second way to get it wrong.
  const lookback = env.ANALYTICS_RAW_RETENTION_DAYS + 1
  const from = addDays(today, -lookback)

  // Read as text for the reason `./day` opens with: a `date` comes back through
  // the driver at the server's local midnight, which is the previous day west of
  // UTC.
  const eventDays = await db.execute(sql`
    select distinct to_char(
      ${analyticsEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD'
    ) as day
    from ${analyticsEvents}
    where ${analyticsEvents.createdAt} >= ${dayStart(from).toISOString()}
    order by 1
  `)

  const dailyDays = await db.execute(sql`
    select distinct to_char(${analyticsDaily.day}, 'YYYY-MM-DD') as day
    from ${analyticsDaily}
    where ${analyticsDaily.day} >= ${from}
    order by 1
  `)

  const done = new Set(daysFromRows(dailyDays.rows))
  // The query orders ascending, so the oldest hole is first — which is the one
  // retention is waiting on, and therefore the one that must not be deferred.
  const holes = daysFromRows(eventDays.rows).filter((day) => !done.has(day))

  // A `Set` keeps insertion order, so a `today` that is also a hole stays at the
  // front rather than being re-added where the hole was.
  const due = [...new Set([today, addDays(today, -1), ...holes])]

  return {
    days: due.slice(0, MAX_AGGREGATE_DAYS_PER_RUN),
    deferred: due.slice(MAX_AGGREGATE_DAYS_PER_RUN),
  }
}

/** The days that need it, and what rebuilding them produced. */
export interface AggregatePendingResult extends AggregateDaysResult {
  /** Days that were due but did not fit in this run. */
  deferred: string[]
}

/** Find the days that are behind and rebuild them. */
export async function aggregatePending(
  now: Date = new Date(),
): Promise<AggregatePendingResult> {
  const pending = await pendingDays(now)
  const rebuilt = await aggregateDays(pending.days)

  return { ...rebuilt, deferred: pending.deferred }
}

/* -------------------------------------------------------------------------- */
/*  The count the admin list shows                                             */
/* -------------------------------------------------------------------------- */

export interface ViewCountRefresh {
  /** Documents whose stored count was rewritten. Zero on a quiet minute. */
  updated: number
}

/**
 * Fold the daily totals into `content_index.view_count`.
 *
 * The admin's content list has a Views column and a "sort by views" option, and
 * both read this column. Nothing wrote it, so it was zero for every document:
 * a column of zeroes reads as "nobody has ever read this", which is a claim the
 * site cannot make, and the sort it offers ordered the whole list by nothing at
 * all. Filling it is not a new feature — it is what the column and the index
 * under it were already for.
 *
 * The source is `analytics_daily` rather than `analytics_events`, because that
 * is what the analytics page totals: the same views, summed over a range there
 * and over all of it here, so the two screens cannot disagree about a document.
 *
 * Written as one statement, keyed by primary key, and only over the rows that
 * differ. That last part is what makes it safe to run on every aggregate pass:
 * a document whose count has not moved is not rewritten, so this never touches
 * `updated_at` and never turns a quiet minute into a table-wide write.
 */
export async function refreshViewCounts(): Promise<ViewCountRefresh> {
  const result = await db.execute(sql`
    with totals as (
      select content_id, sum(views)::int as views
      from ${analyticsDaily}
      where content_id is not null
      group by content_id
    ),
    changed as (
      select c.id, coalesce(t.views, 0)::int as views
      from ${contentIndex} c
      left join totals t on t.content_id = c.id
      where c.view_count is distinct from coalesce(t.views, 0)
    )
    update ${contentIndex} as c
    set view_count = changed.views
    from changed
    where c.id = changed.id
  `)

  return { updated: result.rowCount ?? 0 }
}
