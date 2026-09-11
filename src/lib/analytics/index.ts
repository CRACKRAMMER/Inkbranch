import 'server-only'

/**
 * Analytics: collection, aggregation, retention.
 *
 * The public surface. The beacon route, the admin dashboard and the worker
 * import from here and nowhere else, so the rules enforced inside `collect.ts` —
 * no address, no full referrer, no user agent, no identity that outlives the day
 * — are not something a caller can step around by importing a lower-level file.
 *
 * `ANALYTICS_ENABLED` gates collection only. Reading history, rolling days up
 * and pruning raw events keep working when collection is off: turning analytics
 * off should stop the site from recording, not erase what it already knows, and
 * not leave the days already recorded unaggregated with no retention behind
 * them. `analyticsEnabled()` is what the dashboard and the beacon route ask, so
 * they never read the flag themselves.
 */

export { analyticsEnabled, recordPageView, VISITOR_COOKIE_NAME } from './collect'
export type { PageViewDropReason, PageViewOutcome, VisitorCookie } from './collect'

export {
  MAX_AGGREGATE_DAYS_PER_RUN,
  aggregateDay,
  aggregateDays,
  aggregatePending,
  aggregateRange,
  pendingDays,
  refreshViewCounts,
} from './aggregate'
export type {
  AggregateDaysResult,
  AggregatePendingResult,
  AggregateResult,
  PendingDays,
  ViewCountRefresh,
} from './aggregate'

export {
  AnalyticsRangeError,
  getAnalyticsSummary,
  getTopContent,
  getTrafficWindows,
  MAX_RANGE_DAYS,
  MAX_TOP_CONTENT_LIMIT,
  rangeSchema,
  TRAFFIC_WINDOW_DAYS,
} from './query'
export type {
  AnalyticsSummary,
  DateRange,
  TopContentEntry,
  TopContentViews,
  TrafficWindows,
  ViewCounts,
} from './query'

export { pruneRawEvents } from './retention'
export type { PruneResult } from './retention'
