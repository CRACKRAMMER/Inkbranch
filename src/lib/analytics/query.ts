import 'server-only'
import { and, asc, desc, eq, gte, lte, ne, sql, sum } from 'drizzle-orm'
import { z } from 'zod'
import { documentUrl } from '@/lib/content/paths'
import { db } from '@/lib/db'
import {
  analyticsDaily,
  contentIndex,
  type ContentStatus,
  type ContentType,
  type DeviceType,
} from '@/lib/db/schema'
import { eachDay, isDay } from './day'

/**
 * Reads for the admin dashboard.
 *
 * Three shapes, all from `analytics_daily`: a summary with a per-day series, the
 * top content, and the referrer and device splits. The table stores one row per
 * (day, path, referrer, device, country) rather than one row per day, so every
 * number here is a roll-up of those rows — which is also why `visitors` is a sum
 * of per-dimension uniques rather than a count of distinct readers. See
 * `DayRollup.totals` for what that does and does not mean.
 *
 * Every range predicate is `day >= from AND day <= to`, which is what
 * `analytics_daily_day_idx` answers; the uniqueness index leads with `day` too,
 * so both are usable for it.
 *
 * There is no `device <> 'bot'` filter anywhere, and that is deliberate: crawler
 * beacons are dropped in `collect.ts` before they are written, so a crawler row
 * cannot exist here to be filtered out.
 */

/* -------------------------------------------------------------------------- */
/*  Range                                                                      */
/* -------------------------------------------------------------------------- */

/** Longest range the dashboard may ask for. A year and a day, mostly to catch typos. */
export const MAX_RANGE_DAYS = 366

const dayField = z.string().refine(isDay, 'must be a YYYY-MM-DD day')

export const rangeSchema = z
  .object({ from: dayField, to: dayField })
  .refine((range) => range.from <= range.to, 'from must not be after to')
  .refine(
    (range) => eachDay(range.from, range.to).length <= MAX_RANGE_DAYS,
    `range must not exceed ${MAX_RANGE_DAYS} days`,
  )

export interface DateRange {
  from: string
  to: string
}

/**
 * Thrown when a caller asks for a range that cannot be answered.
 *
 * An error rather than a clamped range: this is called from the dashboard, where
 * a bad range is a bug or a hand-edited URL, and a chart that silently shows a
 * different range than the one it claims is worse than an error the operator can
 * see. An `AnalyticsRangeError` is the caller's fault and can be answered with a
 * 400; anything else from this module is not.
 */
export class AnalyticsRangeError extends Error {
  readonly code = 'ANALYTICS_RANGE'
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsRangeError'
  }
}

function parseRange(input: DateRange): DateRange {
  const parsed = rangeSchema.safeParse(input)

  if (!parsed.success) {
    throw new AnalyticsRangeError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'range'}: ${issue.message}`)
        .join('; '),
    )
  }

  return parsed.data
}

function inRange(range: DateRange) {
  return and(
    gte(analyticsDaily.day, range.from),
    lte(analyticsDaily.day, range.to),
  )
}

/* -------------------------------------------------------------------------- */
/*  Summary                                                                    */
/* -------------------------------------------------------------------------- */

/** Dashboard lists are short by design; the whole table is a page of its own. */
const SUMMARY_TOP_LIMIT = 10

export interface ViewCounts {
  views: number
  visitors: number
}

export interface AnalyticsSummary extends DateRange {
  /**
   * Summed over the range.
   *
   * `visitors` is the sum of the table's per-dimension unique counts: a reader
   * who arrived on two paths, or from two referrers, is counted more than once.
   * It is an upper bound on distinct readers, and it is the honest one — the
   * schema stores uniques per dimension and a range-wide distinct count cannot
   * be recovered from it.
   */
  totals: ViewCounts
  /** One entry per day in the range, in order, zero-filled for quiet days. */
  series: (ViewCounts & { day: string })[]
  /** Paths by views, busiest first. */
  topPaths: (ViewCounts & { path: string })[]
  /** External referrer hosts by views, busiest first. Direct traffic is not a referrer. */
  topReferrers: (ViewCounts & { domain: string })[]
  /** Views by device class. */
  devices: (ViewCounts & { device: DeviceType })[]
}

/**
 * Everything the dashboard header, the traffic chart and the three lists need.
 *
 * Four queries over the same index range rather than one query with grouping
 * sets: each is small, each is readable, and the range is the same in all four,
 * so the cost is one index scan apiece on a table that holds one row per
 * dimension per day.
 */
export async function getAnalyticsSummary(
  input: DateRange,
): Promise<AnalyticsSummary> {
  const range = parseRange(input)

  const [seriesRows, pathRows, referrerRows, deviceRows] = await Promise.all([
    db
      .select({
        day: sql<string>`to_char(${analyticsDaily.day}, 'YYYY-MM-DD')`,
        views: sum(analyticsDaily.views).mapWith(Number),
        visitors: sum(analyticsDaily.visitors).mapWith(Number),
      })
      .from(analyticsDaily)
      .where(inRange(range))
      .groupBy(analyticsDaily.day)
      .orderBy(asc(analyticsDaily.day)),

    db
      .select({
        path: analyticsDaily.path,
        views: sum(analyticsDaily.views).mapWith(Number),
        visitors: sum(analyticsDaily.visitors).mapWith(Number),
      })
      .from(analyticsDaily)
      .where(inRange(range))
      .groupBy(analyticsDaily.path)
      .orderBy(desc(sum(analyticsDaily.views)), asc(analyticsDaily.path))
      .limit(SUMMARY_TOP_LIMIT),

    db
      .select({
        domain: analyticsDaily.referrerDomain,
        views: sum(analyticsDaily.views).mapWith(Number),
        visitors: sum(analyticsDaily.visitors).mapWith(Number),
      })
      .from(analyticsDaily)
      .where(and(inRange(range), ne(analyticsDaily.referrerDomain, '')))
      .groupBy(analyticsDaily.referrerDomain)
      .orderBy(desc(sum(analyticsDaily.views)), asc(analyticsDaily.referrerDomain))
      .limit(SUMMARY_TOP_LIMIT),

    db
      .select({
        device: analyticsDaily.device,
        views: sum(analyticsDaily.views).mapWith(Number),
        visitors: sum(analyticsDaily.visitors).mapWith(Number),
      })
      .from(analyticsDaily)
      .where(inRange(range))
      .groupBy(analyticsDaily.device)
      .orderBy(desc(sum(analyticsDaily.views)), asc(analyticsDaily.device)),
  ])

  // Quiet days have no rows, and a chart wants them as zeroes rather than as
  // gaps: a missing day and a day with no readers look the same in a line chart,
  // and only one of them is true.
  const byDay = new Map(seriesRows.map((row) => [row.day, row]))
  const series = eachDay(range.from, range.to).map((day) => {
    const row = byDay.get(day)
    return { day, views: row?.views ?? 0, visitors: row?.visitors ?? 0 }
  })

  // The header totals come from the same rows the chart is drawn from, so the
  // two cannot disagree.
  const totals = series.reduce<ViewCounts>(
    (sums, entry) => ({
      views: sums.views + entry.views,
      visitors: sums.visitors + entry.visitors,
    }),
    { views: 0, visitors: 0 },
  )

  return {
    from: range.from,
    to: range.to,
    totals,
    series,
    topPaths: pathRows.map((row) => ({
      path: row.path,
      views: row.views,
      visitors: row.visitors,
    })),
    topReferrers: referrerRows.map((row) => ({
      domain: row.domain,
      views: row.views,
      visitors: row.visitors,
    })),
    devices: deviceRows.map((row) => ({
      device: row.device,
      views: row.views,
      visitors: row.visitors,
    })),
  }
}

/* -------------------------------------------------------------------------- */
/*  Top content                                                                */
/* -------------------------------------------------------------------------- */

/** Most rows the dashboard will render in one list. */
export const MAX_TOP_CONTENT_LIMIT = 100

export const topContentSchema = z.object({
  from: dayField,
  to: dayField,
  limit: z.number().int().min(1).max(MAX_TOP_CONTENT_LIMIT),
})

export type TopContentOptions = z.input<typeof topContentSchema>

export interface TopContentViews {
  /** The path the views were recorded under; may be an old URL for a live document. */
  path: string
  views: number
  visitors: number
}

export type TopContentEntry =
  | (TopContentViews & {
      kind: 'content'
      contentId: string
      type: ContentType
      slug: string
      title: string
      /** The document's status *now*, which is not necessarily its status then. */
      status: ContentStatus
      /** The document's current URL. */
      url: string
    })
  | (TopContentViews & {
      /**
       * A path that matches no document in the index.
       *
       * Kept rather than dropped: a 404 that people keep arriving at is
       * information — it is either a link that needs fixing somewhere else or a
       * redirect that was never written — and it is invisible if it is not on
       * this list.
       */
      kind: 'unresolved'
    })

/**
 * The most-viewed paths in a range, joined to the documents they belong to.
 *
 * The join is a left join on `analytics_daily.content_id`, so a path whose
 * document has been deleted, renamed out of existence or never existed comes
 * back as an unresolved entry instead of disappearing from the report.
 *
 * Grouped by (document, path) rather than by document alone: the daily rows keep
 * the path they were recorded under, so a slug that changed shows which of its
 * URLs the traffic came to. A document can therefore appear once per path it has
 * been served under, and `contentId` is what identifies it.
 *
 * Unresolved paths compete with documents for places in the list, which is the
 * point — a 404 that outranks the articles is the most interesting thing the
 * dashboard can say.
 */
export async function getTopContent(
  options: TopContentOptions,
): Promise<TopContentEntry[]> {
  const parsed = parseRange(options)

  const limit = topContentSchema.shape.limit.safeParse(options.limit)
  if (!limit.success) {
    throw new AnalyticsRangeError(
      `limit must be an integer between 1 and ${MAX_TOP_CONTENT_LIMIT}`,
    )
  }

  const rows = await db
    .select({
      contentId: analyticsDaily.contentId,
      path: analyticsDaily.path,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
      views: sum(analyticsDaily.views).mapWith(Number),
      visitors: sum(analyticsDaily.visitors).mapWith(Number),
    })
    .from(analyticsDaily)
    .leftJoin(contentIndex, eq(contentIndex.id, analyticsDaily.contentId))
    .where(inRange(parsed))
    .groupBy(
      analyticsDaily.contentId,
      analyticsDaily.path,
      contentIndex.type,
      contentIndex.slug,
      contentIndex.title,
      contentIndex.status,
    )
    // Ties broken by path so that two runs return the same list in the same
    // order; without it a limit over equal counts is a coin toss.
    .orderBy(desc(sum(analyticsDaily.views)), asc(analyticsDaily.path))
    .limit(limit.data)

  return rows.map((row) => {
    const views: TopContentViews = {
      path: row.path,
      views: row.views,
      visitors: row.visitors,
    }

    if (
      row.contentId !== null &&
      row.type !== null &&
      row.slug !== null &&
      row.title !== null &&
      row.status !== null
    ) {
      return {
        kind: 'content',
        contentId: row.contentId,
        type: row.type,
        slug: row.slug,
        title: row.title,
        status: row.status,
        url: documentUrl(row.type, row.slug),
        ...views,
      }
    }

    return { kind: 'unresolved', ...views }
  })
}
