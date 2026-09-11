import 'server-only'
import { and, eq, gt, gte, lt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { analyticsDaily, analyticsEvents, type DeviceType } from '@/lib/db/schema'
import { dayEnd, dayStart, eachDay, isDay } from './day'

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
