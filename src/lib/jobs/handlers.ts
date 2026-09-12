import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import { env } from '@/env'
import {
  MAX_AGGREGATE_DAYS_PER_RUN,
  aggregateDays,
  aggregatePending,
  pruneRawEvents,
  refreshViewCounts,
  type AggregateDaysResult,
} from '@/lib/analytics'
import { isDay } from '@/lib/analytics/day'
import { findUnusedAssets } from '@/lib/assets/manage'
import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { contentIndex, type ScheduledJobRow } from '@/lib/db/schema'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { updateDocument } from '@/lib/content/writer'
import {
  checkContentDrift,
  findStaleSearchRows,
  markSearchRowsIndexed,
  syncContent,
  syncOneDocument,
} from '@/lib/content/sync'
import type { ContentStatus } from '@/lib/content/schema'
import { captureWithPolicy } from '@/lib/revision/policy'
import { enqueue } from './queue'

/**
 * What each job kind does.
 *
 * `scheduled_jobs.type` holds a value from `JOB_KINDS` and nothing else, so the
 * column cannot name work the worker is unable to run. Adding a kind means
 * adding it here, where the record below stops compiling until it has a handler.
 *
 * Not marked `server-only`: the worker runs under `tsx` outside Next.js. The
 * entry points that run it outside Next pass `--conditions=react-server`, which
 * is what makes the server modules it imports — `@/lib/analytics` among them —
 * resolve rather than throw. `pnpm worker` sets it; so does the embedded worker,
 * by being inside the server process at all.
 */

export const JOB_KINDS = [
  'content.sync',
  'content.drift-check',
  'content.publish-scheduled',
  'search.reindex',
  'analytics.aggregate',
  'analytics.prune',
  'assets.orphan-scan',
] as const

export type JobKind = (typeof JOB_KINDS)[number]

/** What a handler reports back; recorded on the job row under `payload.result`. */
export type JobResult = Record<string, unknown>

export interface JobLogEvent {
  event: string
  [key: string]: unknown
}

/**
 * Where a handler's progress goes.
 *
 * Injected rather than printed, so that `src/lib/jobs` stays free of console
 * output (the application's lint rule) while the worker's actual interface —
 * one JSON object per line on stdout — is implemented at the CLI edge, where
 * console output belongs.
 */
export interface JobLogger {
  info(event: JobLogEvent): void
  error(event: JobLogEvent): void
}

export interface JobContext {
  job: ScheduledJobRow
  /** Aborted when the job has run past its timeout. Handlers that can stop early should. */
  signal: AbortSignal
  log: JobLogger
}

export type JobHandler = (context: JobContext) => Promise<JobResult>

export class UnknownJobKindError extends Error {
  readonly code = 'JOB_UNKNOWN_KIND'
  readonly kind: string
  constructor(kind: string) {
    super(`No handler is registered for job kind "${kind}"`)
    this.name = 'UnknownJobKindError'
    this.kind = kind
  }
}

export class JobHandlerError extends Error {
  readonly code = 'JOB_HANDLER'
  readonly kind: JobKind
  constructor(kind: JobKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JobHandlerError'
    this.kind = kind
  }
}

/**
 * A document stopped being due between the query and the write.
 *
 * Thrown from inside the write lock, where it discards the write rather than
 * performing one nobody asked for: an editor who published, rescheduled or
 * reverted the file in that window wins, which is the only defensible outcome.
 */
export class PublishSupersededError extends Error {
  readonly code = 'JOB_PUBLISH_SUPERSEDED'
  readonly relativePath: string
  constructor(relativePath: string, detail: string) {
    super(`${relativePath} is no longer due for publishing (${detail})`)
    this.name = 'PublishSupersededError'
    this.relativePath = relativePath
  }
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const jobHandlers: Record<JobKind, JobHandler> = Object.freeze({
  'content.sync': runContentSync,
  'content.drift-check': runDriftCheck,
  'content.publish-scheduled': runPublishScheduled,
  'search.reindex': runSearchReindex,
  'analytics.aggregate': runAnalyticsAggregate,
  'analytics.prune': runAnalyticsPrune,
  'assets.orphan-scan': runAssetOrphanScan,
})

/** The handler for a kind, or null when nothing can run it. */
export function resolveHandler(kind: string): JobHandler | null {
  return isKnownJobKind(kind) ? jobHandlers[kind] : null
}

export function isKnownJobKind(kind: string): kind is JobKind {
  return (JOB_KINDS as readonly string[]).includes(kind)
}

/* -------------------------------------------------------------------------- */
/*  content.sync                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Full reconciliation between the filesystem and the content index.
 *
 * This is the only job that may delete index rows, and it deletes them because
 * the file is gone — the index is derived data, re-creatable from the tree.
 */
async function runContentSync({ log }: JobContext): Promise<JobResult> {
  const report = await syncContent()

  if (report.truncated) {
    // The scan stopped at CONTENT_MAX_FILES, which means every file past the
    // cap looked absent and its index row was just deleted. Loud, because the
    // next full sync will not bring those rows back on its own.
    log.error({
      event: 'job.content-sync.truncated',
      limit: env.CONTENT_MAX_FILES,
      scanned: report.scanned,
    })
  }

  const result: JobResult = {
    scanned: report.scanned,
    added: report.added,
    updated: report.updated,
    deleted: report.deleted,
    unchanged: report.unchanged,
    tagsCreated: report.tagsCreated,
    linksResolved: report.linksResolved,
    linksBroken: report.linksBroken,
    durationMs: report.durationMs,
    truncated: report.truncated,
    errorCount: report.errors.length,
    // Bounded: a corpus with a thousand unreadable files must not turn one job
    // row into a megabyte of jsonb.
    errors: report.errors.slice(0, MAX_REPORTED_ERRORS),
  }

  log.info({
    event: 'job.content-sync',
    scanned: report.scanned,
    added: report.added,
    updated: report.updated,
    deleted: report.deleted,
    unchanged: report.unchanged,
    durationMs: report.durationMs,
    truncated: report.truncated,
    errorCount: report.errors.length,
  })

  return result
}

/** Files reported per job. The count beside them is the full figure. */
const MAX_REPORTED_ERRORS = 20

/* -------------------------------------------------------------------------- */
/*  content.drift-check                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cheap check for whether the index and the tree disagree.
 *
 * Reads no file contents, so it is safe to run on a cadence and at boot. When it
 * trips it enqueues the full sync rather than performing one: the check stays
 * cheap, and the expensive half stays visible in the job list.
 */
async function runDriftCheck({ log }: JobContext): Promise<JobResult> {
  const check = await checkContentDrift()

  if (!check.drift) {
    log.info({ event: 'job.content-drift-check', ...check })
    return { drift: false, scanned: check.scanned, indexed: check.indexed }
  }

  // The dedupe key collapses repeated checks into one pending sync, so a tree
  // that is being written to does not queue a sync per minute.
  const queued = await enqueue({
    type: 'content.sync',
    dedupeKey: 'drift',
    payload: { reason: 'drift-check', scanned: check.scanned, indexed: check.indexed },
  })

  log.info({
    event: 'job.content-drift-check',
    drift: true,
    scanned: check.scanned,
    indexed: check.indexed,
    syncEnqueued: queued !== null,
  })

  return {
    drift: true,
    scanned: check.scanned,
    indexed: check.indexed,
    syncEnqueued: queued !== null,
    syncJobId: queued?.id ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  content.publish-scheduled                                                  */
/* -------------------------------------------------------------------------- */

/** Documents published per run. The next run takes the rest. */
const PUBLISH_BATCH_LIMIT = 50

/**
 * Publish the documents whose moment has arrived.
 *
 * **Publishing moves the file, not just the row.** `content_index` is derived
 * from the frontmatter — its own doc comment says so — and `status` is a
 * frontmatter key. Flipping `content_index.status` alone would look right until
 * the next sync re-read `status: scheduled` from the file and put it back, and
 * in the meantime the site would serve a document whose source still says it is
 * not published. Files are the source of truth, so the file is what changes;
 * `syncOneDocument` then brings the row along.
 *
 * The write goes through `updateDocument`, which is the atomic writer: write to
 * `.tmp`, fsync, rename. A direct write would leave a window where a reader sees
 * a half-written article.
 */
async function runPublishScheduled({ log }: JobContext): Promise<JobResult> {
  const now = new Date()

  const due = await db
    .select({
      id: contentIndex.id,
      path: contentIndex.path,
      status: contentIndex.status,
      scheduledAt: contentIndex.scheduledAt,
    })
    .from(contentIndex)
    .where(
      and(
        eq(contentIndex.status, 'scheduled'),
        isNotNull(contentIndex.scheduledAt),
        lte(contentIndex.scheduledAt, now),
      ),
    )
    .orderBy(asc(contentIndex.scheduledAt))
    .limit(PUBLISH_BATCH_LIMIT)

  const published: string[] = []
  const skipped: { path: string; reason: string }[] = []
  const errors: { path: string; message: string }[] = []

  for (const row of due) {
    try {
      await publishDocument(row.path, now)
      published.push(row.path)
    } catch (error) {
      if (error instanceof PublishSupersededError) {
        skipped.push({ path: row.path, reason: error.message })
        continue
      }
      errors.push({
        path: row.path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const result: JobResult = {
    due: due.length,
    published,
    publishedCount: published.length,
    skipped,
    errorCount: errors.length,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    // More were waiting than one run takes; the next run continues from here.
    truncated: due.length === PUBLISH_BATCH_LIMIT,
  }

  log.info({
    event: 'job.content-publish-scheduled',
    due: due.length,
    published: published.length,
    skipped: skipped.length,
    errorCount: errors.length,
    truncated: result.truncated === true,
  })

  if (errors.length > 0) {
    log.error({
      event: 'job.content-publish-scheduled.failed',
      count: errors.length,
      first: errors[0],
    })
  }

  return result
}

/**
 * Whether a document's scheduled moment has arrived.
 *
 * Null `scheduledAt` is never due: a document with no moment has not asked to be
 * published at one. The boundary is inclusive — a document scheduled for this
 * second goes live on this run rather than the next one.
 */
export function isPublishDue(
  document: { status: ContentStatus; scheduledAt: Date | null },
  now: Date,
): boolean {
  if (document.status !== 'scheduled') return false
  if (!document.scheduledAt) return false
  return document.scheduledAt.getTime() <= now.getTime()
}

/**
 * The frontmatter a scheduled publish writes.
 *
 * One function, called twice: once inside the write's mutate callback, and once
 * afterwards so the revision store can be told what the write produced. Two
 * copies of this would be two answers to "what does publishing change", and the
 * revision's line counts would eventually be computed against the wrong one.
 *
 * `publishAt` is when the document should go live; `date`/`publishedAt` is when
 * it did. The frontmatter schema rejects `status: published` without one of the
 * latter two on a post or a project, so a file carrying only `publishAt` would
 * fail to parse the moment it was read back — and a document that cannot be
 * parsed disappears from the index.
 */
function publishedFrontmatter(
  source: Record<string, unknown>,
  body: string,
  scheduledAt: Date | null,
  now: Date,
): { data: Record<string, unknown>; body: string; comment: string } {
  const data: Record<string, unknown> = { ...source, status: 'published' }
  if (data.date == null && data.publishedAt == null) {
    data.date = scheduledAt ?? now
  }
  return { data, body, comment: 'Published on schedule' }
}

/**
 * Read the file, publish it, and refresh the index. Idempotent by construction.
 *
 * ## Why this records a revision and an audit row
 *
 * It is a save. Nobody pressed anything, but a scheduled publish is the moment a
 * document stops being a draft and starts being public, and it rewrites the
 * frontmatter to do it — so §19's rule that every formal save leaves a revision
 * applies here or it does not apply at all. The state being replaced is the
 * scheduled draft, which exists nowhere else once this returns; without the
 * snapshot, "put it back the way it was until I check the date" is not something
 * the operator can do.
 *
 * The audit row is the same argument on §34's side. The entry names no actor,
 * because there is none: `recordAudit` writes a null `user_id` for the CLI, the
 * importer and jobs, and the metadata says which of those this was rather than
 * leaving a reader to infer it from a timestamp.
 *
 * ## Why the capture happens after the sync
 *
 * `captureRevision` needs the `content_index.id` the revision hangs off, and the
 * row is derived from the file — so it has to be the row as it is *after* the
 * status changed, which is the one the sync just wrote. `syncOneDocument`
 * returns that row and the document it was built from, so this costs no extra
 * query. A publish whose file has vanished by the time the sync runs records
 * nothing, because there is then nothing to attach it to.
 *
 * ## How the capture knows what the write produced
 *
 * A revision stores the state a write *replaced*, but its line counts are the
 * difference between that state and the one that replaced it — so the capture
 * has to be told what the new frontmatter is. That value is produced inside the
 * mutate callback, and lifting it out through a closure is the kind of capture
 * that control-flow analysis cannot follow and a reader cannot check.
 *
 * So it is recomputed instead, from the text the callback was handed:
 * `publishedFrontmatter` is pure and `previousContent` is those same bytes, so
 * applying it to the same input yields the same result by construction. The one
 * input that is not in the text alone is `scheduledAt`, which comes from the
 * freshly synced document — where it is non-null, because `isPublishDue`
 * refuses to publish a document that has no scheduled moment.
 */
async function publishDocument(relativePath: string, now: Date): Promise<void> {
  const write = await updateDocument(relativePath, (current) => {
    // The row was read before the lock was taken; the file is the fresher of
    // the two and may have been edited, published or rescheduled since. Re-check
    // under the lock so an editor's change is never overwritten.
    if (
      !isPublishDue(
        { status: current.status, scheduledAt: current.scheduledAt },
        now,
      )
    ) {
      throw new PublishSupersededError(
        relativePath,
        `file now says status "${current.status}"`,
      )
    }

    const parsed = parseFrontmatter(current.raw)
    return publishedFrontmatter(
      parsed.data,
      current.body,
      current.scheduledAt,
      now,
    )
  })

  const synced = await syncOneDocument(relativePath)
  if (!synced || write.previousContent === null) return

  // `previousContent` is the text the callback was handed, and `ContentDocument.body`
  // is `parseFrontmatter(raw).content` — the reader's own derivation — so this is
  // the same pair the writer was given, not a second reading of it.
  const before = parseFrontmatter(write.previousContent)
  const after = publishedFrontmatter(
    before.data,
    before.content,
    synced.document.scheduledAt,
    now,
  )

  await captureWithPolicy({
    contentId: synced.row.id,
    type: synced.document.type,
    slug: synced.document.slug,
    data: after.data,
    body: after.body,
    previousContent: write.previousContent,
    reason: 'publish',
    // No actor: a job is not a person, and naming one would make the log say
    // somebody published this on purpose.
    actorId: null,
  })

  await recordAudit({
    action: 'post.publish',
    actorId: null,
    targetType: 'content',
    targetId: relativePath,
    metadata: {
      // The same action the admin's publish button writes, distinguished by this
      // field rather than by a second action meaning the same thing.
      via: 'schedule',
      type: synced.document.type,
      slug: synced.document.slug,
    },
  })
}

/* -------------------------------------------------------------------------- */
/*  search.reindex                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bring rows written under an older search document shape up to date.
 *
 * `SEARCH_INDEX_VERSION` exists so that adding a field to a search document is a
 * one-line change with a work list attached — this job is that work list. The
 * local provider builds its index from the Markdown files at query time, so
 * there is nothing to push anywhere: the row *is* what a local search reads.
 * A remote provider would push each document between the two calls below, and
 * only then stamp it.
 *
 * The stamp is not a claim that a remote index holds the document — every
 * `syncContent` stamps the rows it writes for the same reason. It records the
 * shape the row was last written in, so `findStaleSearchRows` keeps returning
 * only the rows a version bump actually missed.
 */
async function runSearchReindex({ log }: JobContext): Promise<JobResult> {
  const stale = await findStaleSearchRows()

  if (stale.length === 0) {
    return { provider: env.SEARCH_PROVIDER, stale: 0, marked: 0 }
  }

  switch (env.SEARCH_PROVIDER) {
    case 'local': {
      const marked = await markSearchRowsIndexed(stale.map((row) => row.id))
      const result: JobResult = {
        provider: 'local',
        stale: stale.length,
        marked,
        sample: stale.slice(0, 10).map((row) => row.path),
      }
      log.info({
        event: 'job.search-reindex',
        provider: 'local',
        stale: stale.length,
        marked,
      })
      return result
    }
    default: {
      // Unreachable while `SEARCH_PROVIDER` is a single-value enum, which is the
      // point: adding a second value to `src/env.ts` fails to compile here until
      // someone writes the push, rather than silently marking rows as indexed
      // when no index was updated.
      const unreachable: never = env.SEARCH_PROVIDER
      throw new JobHandlerError(
        'search.reindex',
        `No push implementation for search provider "${String(unreachable)}"`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  analytics.aggregate                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Roll raw page views into the daily table the dashboard reads.
 *
 * The work is `@/lib/analytics`'s; this handler decides *which* days and records
 * what happened, in that order of importance. There is nothing to pass in for
 * the usual case — the module derives the days that are behind from the tables
 * themselves, which is the only version of "what still needs doing" that cannot
 * go stale — and a payload naming days is honoured for the one caller that has
 * a list rather than a query: the retention pass below, which is holding days
 * older than the window that query looks back over.
 *
 * A job that reports an aggregation it did not perform would be worse than no
 * job at all, so the result carries the days that were actually rebuilt, the
 * days that had nothing to rebuild, and the days that had to wait.
 */
async function runAnalyticsAggregate({ job, log }: JobContext): Promise<JobResult> {
  const named = requestedDays(job.payload)

  /*
   * Days that did not fit are deferred, whichever way the list was arrived at: a
   * caller that hands over a hundred days gets the first batch now and the rest
   * on the next run, and says so, rather than dropping them quietly. The
   * declared type is the union of both shapes because the two branches differ
   * only in where `deferred` comes from — the payload, or the sweep's own
   * backlog.
   */
  const pending: AggregateDaysResult & { deferred: string[] } = named
    ? { ...(await aggregateDays(named.days)), deferred: named.deferred }
    : await aggregatePending()

  const deferred = pending.deferred

  /*
   * The Views column in the content list is a sum over the daily table, so it
   * is refreshed here rather than by a pass of its own: this is the only place
   * `analytics_daily` changes, and a rebuild of no day means there is nothing
   * new to fold in. The guard is what keeps a quiet site from paying two scans
   * a minute for an update that would write nothing.
   */
  const viewCounts =
    pending.aggregated.length > 0 ? await refreshViewCounts() : { updated: 0 }

  log.info({
    event: 'job.analytics-aggregate',
    requested: named ? named.days.length : null,
    aggregated: pending.aggregated.length,
    empty: pending.empty.length,
    deferred: deferred.length,
    rows: pending.rows,
    views: pending.views,
    visitors: pending.visitors,
    viewCounts: viewCounts.updated,
  })

  if (deferred.length > 0) {
    // Reported at error level because it is the one thing an operator can act
    // on: a backlog that does not shrink between runs means the cadence is not
    // keeping up with the traffic, not that this run went wrong.
    log.error({
      event: 'job.analytics-aggregate.behind',
      deferred: deferred.length,
      oldest: deferred[0],
    })
  }

  return {
    requested: named?.days ?? null,
    aggregated: pending.aggregated,
    empty: pending.empty,
    deferred,
    rows: pending.rows,
    views: pending.views,
    visitors: pending.visitors,
    viewCounts: viewCounts.updated,
  }
}

/**
 * The days a job payload names, or null when it names none.
 *
 * A payload that asks for days and names none this can read is refused rather
 * than quietly turned into the full sweep: "aggregate these forty days" and
 * "aggregate whatever looks behind" are different jobs with the same cost, and a
 * payload bug that silently ran one instead of the other would be invisible
 * until someone compared the dashboard against the traffic.
 */
function requestedDays(payload: Record<string, unknown>): {
  days: string[]
  deferred: string[]
} | null {
  const raw = payload.days
  if (raw === undefined) return null

  if (!Array.isArray(raw)) {
    throw new JobHandlerError(
      'analytics.aggregate',
      `Job payload "days" is not an array (got ${typeof raw})`,
    )
  }

  const named = [
    ...new Set(raw.filter((day): day is string => typeof day === 'string' && isDay(day))),
  ].sort()

  if (named.length === 0) {
    throw new JobHandlerError(
      'analytics.aggregate',
      `Job payload "days" names no day this can read: ${JSON.stringify(raw).slice(0, 200)}`,
    )
  }

  return {
    days: named.slice(0, MAX_AGGREGATE_DAYS_PER_RUN),
    deferred: named.slice(MAX_AGGREGATE_DAYS_PER_RUN),
  }
}

/* -------------------------------------------------------------------------- */
/*  analytics.prune                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Delete raw page views past their retention window.
 *
 * The rule that makes this safe lives in `@/lib/analytics/retention`, and the
 * interesting half of it is a refusal: a day whose events have not been rolled
 * up yet is left alone, because the events are the only copy of that day and
 * deleting them would destroy it. This handler's job is what happens next —
 * those days are handed to an aggregation job, so that the next prune can
 * finish what this one had to leave.
 *
 * A non-empty withheld list is not this job failing. It is aggregation being
 * behind, and it is reported as such: at error level, because an operator is the
 * only one who can do anything about it, but with the job itself recorded as
 * done, because it was.
 */
async function runAnalyticsPrune({ log }: JobContext): Promise<JobResult> {
  const result = await pruneRawEvents()

  const aggregate =
    result.withheldDays.length > 0
      ? await enqueue({
          type: 'analytics.aggregate',
          // Collapses repeats while one is pending. The cadence enqueues the
          // same kind under its own key, which is deliberate: those two jobs ask
          // for different days, and deduplicating across them would silently
          // replace one list with the other.
          dedupeKey: 'retention',
          payload: { days: result.withheldDays, reason: 'retention-withheld' },
        })
      : null

  if (result.withheldDays.length > 0) {
    log.error({
      event: 'job.analytics-prune.withheld',
      days: result.withheldDays.length,
      oldest: result.withheldDays[0],
      newest: result.withheldDays[result.withheldDays.length - 1],
      aggregateJobId: aggregate?.id ?? null,
    })
  }

  log.info({
    event: 'job.analytics-prune',
    deleted: result.deleted,
    withheld: result.withheldDays.length,
  })

  return {
    deleted: result.deleted,
    withheld: result.withheldDays.length,
    oldestWithheld: result.withheldDays[0] ?? null,
    aggregateJobId: aggregate?.id ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  assets.orphan-scan                                                         */
/* -------------------------------------------------------------------------- */

/** Orphans one scan looks for. The job says when it stopped at the cap. */
const ORPHAN_SCAN_LIMIT = 200
/** Orphans named in the job's result. The count beside them is the full figure. */
const MAX_REPORTED_ORPHANS = 20

/**
 * Find uploads nothing references. **Report them; do not delete them.**
 *
 * The obvious version of this job deletes, and it is the wrong one. What counts
 * as a reference is derived data — image links are extracted into `content_links`
 * by the content sync — so a tree that has not been synced yet makes every asset
 * in it look unreferenced, and the failure mode of acting on that is a deleted
 * file that a published page still points at. `findUnusedAssets` calls what it
 * returns a proposal, and the admin is where a proposal is accepted: a human,
 * seeing which documents reference what, with a confirmation in front of them.
 *
 * What is left is still worth running on a timer. An upload directory that only
 * grows is a disk that fills up silently, and a count that appears in the job
 * list every interval is a standing answer to "is anything rotting in here?"
 * that nobody has to remember to ask for.
 */
async function runAssetOrphanScan({ log }: JobContext): Promise<JobResult> {
  const orphans = await findUnusedAssets({ limit: ORPHAN_SCAN_LIMIT })
  const bytes = orphans.reduce((total, asset) => total + asset.size, 0)
  const truncated = orphans.length >= ORPHAN_SCAN_LIMIT

  log.info({
    event: 'job.assets-orphan-scan',
    found: orphans.length,
    bytes,
    truncated,
  })

  return {
    found: orphans.length,
    bytes,
    truncated,
    sample: orphans.slice(0, MAX_REPORTED_ORPHANS).map((asset) => ({
      id: asset.id,
      path: asset.path,
      bytes: asset.size,
    })),
  }
}
