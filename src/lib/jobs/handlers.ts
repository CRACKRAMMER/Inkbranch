import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import { env } from '@/env'
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
import { enqueue } from './queue'

/**
 * What each job kind does.
 *
 * `scheduled_jobs.type` holds a value from `JOB_KINDS` and nothing else, so the
 * column cannot name work the worker is unable to run. Adding a kind means
 * adding it here, where the record below stops compiling until it has a handler.
 *
 * Not marked `server-only`: the worker runs under `tsx` outside Next.js, and
 * `server-only` is not a dependency of this project.
 *
 * Deliberately absent: `analytics.aggregate`, `analytics.prune` and
 * `assets.cleanup`. Their modules (`src/lib/analytics`, `src/lib/assets`) do not
 * exist yet. A handler that reports an aggregation it did not perform is worse
 * than a job kind that cannot be enqueued, so they arrive with their modules.
 */

export const JOB_KINDS = [
  'content.sync',
  'content.drift-check',
  'content.publish-scheduled',
  'search.reindex',
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

/** Read the file, publish it, and refresh the index. Idempotent by construction. */
async function publishDocument(relativePath: string, now: Date): Promise<void> {
  await updateDocument(relativePath, (current) => {
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
    const data: Record<string, unknown> = { ...parsed.data, status: 'published' }

    // `publishAt` is when the document should go live; `date`/`publishedAt` is
    // when it did. The frontmatter schema rejects `status: published` without
    // one of the latter two on a post or a project, so a file carrying only
    // `publishAt` would fail to parse the moment it was read back — and a
    // document that cannot be parsed disappears from the index.
    if (data.date == null && data.publishedAt == null) {
      data.date = current.scheduledAt ?? now
    }

    return { data, body: current.body, comment: 'Published on schedule' }
  })

  await syncOneDocument(relativePath)
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
