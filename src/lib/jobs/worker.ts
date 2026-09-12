import os from 'node:os'
import { desc, eq } from 'drizzle-orm'
import { env } from '@/env'
import { closeDatabase, db, pingDatabase } from '@/lib/db'
import { scheduledJobs, type ScheduledJobRow } from '@/lib/db/schema'
import { claimNextJob, completeJob, enqueue, failJob, pruneFinishedJobs } from './queue'
import {
  resolveHandler,
  UnknownJobKindError,
  type JobKind,
  type JobLogger,
  type JobResult,
} from './handlers'

/**
 * The worker loop.
 *
 * Claim a job, run it under a timeout, record the outcome, repeat. Nothing here
 * does the work itself; the handlers do, and this is the only module that knows
 * about ordering, timeouts and shutdown.
 *
 * Two properties matter more than the loop's shape:
 *
 * - **A handler that throws does not end the worker.** A queue whose consumer
 *   dies on the first bad job stops draining, and the jobs behind the bad one
 *   never run. Failures are recorded and the loop continues.
 * - **Shutdown leaves no claim behind.** A worker killed mid-job that keeps its
 *   claim leaves the job locked until the lease expires; if it is killed often
 *   enough, work that only one worker is doing never finishes. The job in hand
 *   is given a grace period to finish, and is failed — which releases the claim
 *   — when it does not.
 *
 * Not marked `server-only`: this file is loaded by `scripts/worker.ts` under
 * `tsx`, outside Next.js, and `server-only` is not a dependency of this project.
 */

/** How long one job may run before it is treated as failed. */
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000

/**
 * How long a job in hand may keep running after a shutdown signal.
 *
 * Must stay below `CLAIM_STALE_MS`, so a worker that exits on the grace period
 * releases its claim rather than leaving it to expire.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000

/**
 * How often to look for work when the queue is empty.
 *
 * Below the maintenance cadence on purpose: a job enqueued by an admin save
 * should start in seconds, while a drift check does not need to run every few
 * seconds to be useful.
 */
export const DEFAULT_POLL_MS = 5_000

/** How long a kind that failed stays untouched by the cadence. */
export const CADENCE_FAILURE_COOL_OFF_MS = 30 * 60_000

/** Longest worker id accepted; `locked_by` is 80 characters. */
const WORKER_ID_MAX_LENGTH = 80

/** One kind of work the worker creates for itself, and how often. */
interface CadenceEntry {
  kind: JobKind
  /**
   * How long this kind may go unrun.
   *
   * Floored in practice by the check interval: the loop looks at this table on
   * every `WORKER_INTERVAL_MS`, so raising that value raises every period below
   * it. It is a floor rather than a floor *and* a ceiling on purpose — a period
   * is a promise about staleness, and running something later than promised is
   * the failure an operator would notice, while running it slightly sooner never
   * is.
   */
  everyMs: number
}

/**
 * Work the worker creates for itself.
 *
 * Enqueued rather than run inline, so that the cadence takes the same claim,
 * retry and timeout path as everything else — and so that a run that never
 * happened is visible as a job that never appeared.
 *
 * ## Why each kind has its own period
 *
 * A single period for all of them means every entry is set by the most impatient
 * one. Two are minutes-old-or-nothing (a drift check, a publish pass), and if
 * the rest share their period then a search reindex — a migration work list that
 * changes when a developer changes a constant — is queried once a minute for
 * years, and an orphan scan walks the entire asset table at the same rate. The
 * numbers below are each kind's own answer to "how stale may this be?", which is
 * the only question a cadence period is really asking.
 */
const CADENCE: readonly CadenceEntry[] = [
  // Reconciles derived data and flips scheduled posts. Both are cheap queries
  // and both are things an author is waiting to see.
  { kind: 'content.drift-check', everyMs: 60_000 },
  { kind: 'content.publish-scheduled', everyMs: 60_000 },
  // Today is not over until midnight, so today's roll-up is always partial and
  // is rebuilt on every run rather than appended to. Frequent for that reason,
  // not because the numbers are needed quickly.
  { kind: 'analytics.aggregate', everyMs: 60_000 },
  // A migration work list: it has something to do only after a version bump.
  { kind: 'search.reindex', everyMs: 60 * 60_000 },
  // A day of history crosses the cutoff once a day, and an orphan is created by
  // an upload rather than by time.
  { kind: 'analytics.prune', everyMs: 6 * 60 * 60_000 },
  { kind: 'assets.orphan-scan', everyMs: 6 * 60 * 60_000 },
  // The slowest thing here, and the least urgent: both tables it trims are read
  // only by the admin, and a row that should have been deleted an hour ago
  // costs one line in a list rather than a wrong answer. Six hours keeps it off
  // the daily backup's critical path and is far more often than either table
  // grows enough to matter.
  { kind: 'auth.prune', everyMs: 6 * 60 * 60_000 },
]

/**
 * The kinds the worker creates for itself.
 *
 * Exported because it is a fact about the deployment rather than about this
 * loop: these are the jobs that happen because a timer says so and not because
 * anybody asked, so a kind missing from this list is work that silently stops
 * happening. `JOB_KINDS` is the wrong thing to ask — it includes `content.sync`,
 * which only a person or an importer ever enqueues.
 */
export const CADENCE_KINDS: readonly JobKind[] = CADENCE.map((entry) => entry.kind)

export class WorkerStartupError extends Error {
  readonly code = 'WORKER_STARTUP'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorkerStartupError'
  }
}

export class JobTimeoutError extends Error {
  readonly code = 'JOB_TIMEOUT'
  readonly jobId: string
  readonly timeoutMs: number
  constructor(jobId: string, timeoutMs: number) {
    super(`Job ${jobId} exceeded its ${timeoutMs}ms timeout`)
    this.name = 'JobTimeoutError'
    this.jobId = jobId
    this.timeoutMs = timeoutMs
  }
}

export class WorkerShutdownError extends Error {
  readonly code = 'WORKER_SHUTDOWN'
  readonly jobId: string
  constructor(jobId: string) {
    super(`Worker shut down before job ${jobId} finished`)
    this.name = 'WorkerShutdownError'
    this.jobId = jobId
  }
}

export interface WorkerOptions {
  workerId?: string
  /** Aborting this stops the loop: the job in hand gets `shutdownGraceMs`. */
  signal?: AbortSignal
  /**
   * Where the worker's output goes. Silent by default, and supplied by
   * `scripts/worker.ts`: a worker embedded in the application process must not
   * print on a timer, and the CLI is the thing whose output is its interface.
   */
  logger?: JobLogger
  intervalMs?: number
  pollMs?: number
  jobTimeoutMs?: number
  shutdownGraceMs?: number
  /**
   * Close the shared connection pool before returning. True for the CLI, which
   * must exit; false in-process, where that pool belongs to request handling.
   */
  closeDatabaseOnExit?: boolean
}

export interface WorkerSummary {
  workerId: string
  claimed: number
  completed: number
  failed: number
  maintenanceRuns: number
  startedAt: Date
  stoppedAt: Date
}

interface WorkerSettings {
  pollMs: number
  jobTimeoutMs: number
  shutdownGraceMs: number
  shutdown?: AbortSignal
}

type CompletedOutcome = {
  outcome: 'completed'
  result: JobResult
  durationMs: number
}

type FailedOutcome = {
  outcome: 'failed'
  error: Error
  durationMs: number
  /** True when trying again cannot help: the kind is one nobody can run. */
  terminal?: boolean
}

type InterruptedOutcome = {
  outcome: 'timeout' | 'abandoned'
  error: Error
  durationMs: number
}

type JobOutcome = CompletedOutcome | FailedOutcome | InterruptedOutcome

const SILENT_LOGGER: JobLogger = {
  info: () => undefined,
  error: () => undefined,
}

/* -------------------------------------------------------------------------- */
/*  Loop                                                                       */
/* -------------------------------------------------------------------------- */

export async function runWorker(
  options: WorkerOptions = {},
): Promise<WorkerSummary> {
  const log = options.logger ?? SILENT_LOGGER
  const workerId = (options.workerId ?? defaultWorkerId()).slice(
    0,
    WORKER_ID_MAX_LENGTH,
  )
  const intervalMs = Math.max(1, options.intervalMs ?? env.WORKER_INTERVAL_MS)
  const settings: WorkerSettings = {
    pollMs: Math.max(1, Math.min(options.pollMs ?? DEFAULT_POLL_MS, intervalMs)),
    jobTimeoutMs: Math.max(1, options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS),
    shutdownGraceMs: Math.max(
      1,
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    ),
    shutdown: options.signal,
  }

  const startedAt = new Date()
  const summary: WorkerSummary = {
    workerId,
    claimed: 0,
    completed: 0,
    failed: 0,
    maintenanceRuns: 0,
    startedAt,
    stoppedAt: startedAt,
  }

  let consecutiveFailures = 0
  let started = false

  try {
    await assertReady()
    started = true

    // With the boot check enabled the first cadence runs immediately, so a
    // container that came up against a stale index does not serve it for a full
    // interval; without it, the first cadence waits one interval.
    let nextMaintenanceAt = env.CONTENT_SYNC_ON_BOOT ? 0 : Date.now() + intervalMs

    /*
     * When each kind is next due. Empty at boot, which is what makes the first
     * check run every kind once: a worker that starts has no idea what the last
     * one did, and asking each kind whether it has work is the only way to find
     * out. The alternative — persisting the last-run time of each kind — would
     * be a second copy of something the job table already records.
     */
    const nextDueAt = new Map<JobKind, number>()

    log.info({
      event: 'worker.start',
      workerId,
      pid: process.pid,
      intervalMs,
      pollMs: settings.pollMs,
      jobTimeoutMs: settings.jobTimeoutMs,
      syncOnBoot: env.CONTENT_SYNC_ON_BOOT,
      searchProvider: env.SEARCH_PROVIDER,
    })

    while (!isStopping(settings)) {
      try {
        if (Date.now() >= nextMaintenanceAt) {
          nextMaintenanceAt = Date.now() + intervalMs
          await runCadence(log, nextDueAt)
          await pruneJobHistory(log)
          summary.maintenanceRuns += 1
        }

        const job = await claimNextJob(workerId)
        consecutiveFailures = 0

        if (!job) {
          await sleep(settings.pollMs, settings.shutdown)
          continue
        }

        log.info({
          event: 'worker.job-claimed',
          jobId: job.id,
          kind: job.type,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
        })

        summary.claimed += 1
        const outcome = await runJob(job, log, settings)
        await recordOutcome(job, outcome, log, summary)

        // A shutdown requested while that job ran is honoured now rather than
        // after another claim.
        if (isStopping(settings)) break
      } catch (error) {
        // A failing claim is the database, not the work. Back off instead of
        // spinning: a worker that hammers an unreachable database turns a
        // recoverable outage into a log flood.
        consecutiveFailures += 1
        log.error({
          event: 'worker.loop-error',
          attempt: consecutiveFailures,
          message: describeError(error),
        })
        await sleep(
          Math.min(settings.pollMs * 2 ** consecutiveFailures, intervalMs),
          settings.shutdown,
        )
      }
    }
  } finally {
    summary.stoppedAt = new Date()
    // Only if the loop got going: a worker that failed to start has no stop to
    // report, and saying it stopped would read as a clean shutdown.
    if (started) {
      log.info({
        event: 'worker.stop',
        workerId,
        claimed: summary.claimed,
        completed: summary.completed,
        failed: summary.failed,
        maintenanceRuns: summary.maintenanceRuns,
        ranForMs: summary.stoppedAt.getTime() - summary.startedAt.getTime(),
      })
    }
    if (options.closeDatabaseOnExit) {
      // Without this the process does not exit: `pg` keeps its sockets (and, in
      // production, its idle timers) alive indefinitely.
      await closeDatabase()
    }
  }

  return summary
}

function defaultWorkerId(): string {
  return `worker-${os.hostname()}-${process.pid}`
}

function isStopping(settings: WorkerSettings): boolean {
  return settings.shutdown?.aborted === true
}

/* -------------------------------------------------------------------------- */
/*  Startup                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fail before entering the loop rather than inside it.
 *
 * An unreachable database or a schema that was never migrated would otherwise
 * be retried every few seconds forever, with the reason scrolling past in the
 * logs. Both are configuration mistakes, and a configuration mistake should
 * stop the process with a message that names it.
 */
async function assertReady(): Promise<void> {
  const ping = await pingDatabase()
  if (!ping.ok) {
    throw new WorkerStartupError(
      `Cannot reach the database: ${ping.error ?? 'no error reported'}. Check DATABASE_URL and that Postgres is running.`,
    )
  }

  try {
    await db.select({ id: scheduledJobs.id }).from(scheduledJobs).limit(1)
  } catch (error) {
    throw new WorkerStartupError(
      `The database is reachable but scheduled_jobs cannot be read: ${describeError(error)}. Run "pnpm db:migrate".`,
      { cause: error },
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  Cadence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue whatever is due, and say so either way.
 *
 * The log line is written for kinds that were not enqueued as well as for the
 * ones that were: "the cadence ran and this kind was already pending" and "the
 * cadence did not reach this kind" are different states, and only the first
 * means the worker is doing its job.
 */
async function runCadence(
  log: JobLogger,
  nextDueAt: Map<JobKind, number>,
): Promise<void> {
  const now = Date.now()

  for (const entry of CADENCE) {
    const due = nextDueAt.get(entry.kind)
    if (due !== undefined && now < due) continue

    // Recorded before the enqueue rather than after: a cadence that throws is
    // caught by the loop and backed off, and a kind left unmarked would be
    // retried on every tick of that backoff — which is the flood the backoff
    // exists to prevent.
    nextDueAt.set(entry.kind, now + entry.everyMs)

    const enqueued = await enqueueCadence(entry.kind)
    log.info({
      event: 'worker.cadence',
      kind: entry.kind,
      everyMs: entry.everyMs,
      enqueued: enqueued !== null,
      ...(enqueued ? { jobId: enqueued.id } : {}),
    })
  }
}

/**
 * Delete finished jobs past `JOB_RETENTION_DAYS`.
 *
 * The worker maintains its own table, on the same tick as the cadence that
 * fills it. Left alone this table grows by a few thousand rows a day for as long
 * as the site exists, and the reason it grows is the cadence itself: a tick that
 * recorded nothing would be indistinguishable from a worker that had died, so
 * every tick writes a row whether or not there was work.
 *
 * A sweep that hits its cap says so, and the next tick continues from where it
 * stopped — which is why this is a log line rather than an error.
 */
async function pruneJobHistory(log: JobLogger): Promise<void> {
  const result = await pruneFinishedJobs()
  if (result.deleted === 0) return

  log.info({
    event: 'worker.prune-jobs',
    deleted: result.deleted,
    remaining: result.more,
    retentionDays: env.JOB_RETENTION_DAYS,
  })
}

/**
 * Enqueue one cadence job, unless the last one failed recently.
 *
 * The dedupe key only collapses jobs that are still pending, so a kind that
 * fails terminally would get a fresh failed row every interval — a thousand a
 * day, each one restating the first. The cool-off bounds that, and leaves the
 * decision to re-run a failed job with the operator who can read it.
 */
async function enqueueCadence(kind: JobKind): Promise<ScheduledJobRow | null> {
  const [last] = await db
    .select({ status: scheduledJobs.status, finishedAt: scheduledJobs.finishedAt })
    .from(scheduledJobs)
    .where(eq(scheduledJobs.type, kind))
    .orderBy(desc(scheduledJobs.createdAt))
    .limit(1)

  if (
    last &&
    last.status === 'failed' &&
    last.finishedAt &&
    Date.now() - last.finishedAt.getTime() < CADENCE_FAILURE_COOL_OFF_MS
  ) {
    return null
  }

  return enqueue({ type: kind, dedupeKey: 'cadence' })
}

/* -------------------------------------------------------------------------- */
/*  One job                                                                    */
/* -------------------------------------------------------------------------- */

async function runJob(
  job: ScheduledJobRow,
  log: JobLogger,
  settings: WorkerSettings,
): Promise<JobOutcome> {
  const handler = resolveHandler(job.type)
  if (!handler) {
    // Terminal, not retried: a kind with no handler will not have one at the
    // next attempt either, and four more failures would only delay the moment
    // someone reads the error.
    return {
      outcome: 'failed',
      error: new UnknownJobKindError(job.type),
      durationMs: 0,
      terminal: true,
    }
  }

  const started = Date.now()
  const controller = new AbortController()

  // A timeout is a failure, not a release. The job goes to `failJob`, which
  // either clears the claim and schedules a retry or makes the row terminal;
  // nothing is left claimed either way. The handler itself may still be
  // running — one that ignores its signal keeps going — so a handler has to be
  // safe to run twice. Every handler here is: they reconcile from the
  // filesystem rather than applying a delta.
  const timeoutError = new JobTimeoutError(job.id, settings.jobTimeoutMs)

  let timeoutTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let detachShutdown: (() => void) | undefined

  const interrupted = new Promise<InterruptedOutcome>((resolve) => {
    timeoutTimer = setTimeout(() => {
      controller.abort(timeoutError)
      resolve({ outcome: 'timeout', error: timeoutError, durationMs: 0 })
    }, settings.jobTimeoutMs)

    const shutdown = settings.shutdown
    if (!shutdown) return

    const onAbort = (): void => {
      // The job in hand is allowed to finish, because a sync interrupted at 90%
      // is work thrown away. The grace period is what stops that from meaning
      // "as long as it likes".
      const shutdownError = new WorkerShutdownError(job.id)
      graceTimer = setTimeout(() => {
        controller.abort(shutdownError)
        resolve({ outcome: 'abandoned', error: shutdownError, durationMs: 0 })
      }, settings.shutdownGraceMs)
    }

    if (shutdown.aborted) onAbort()
    else shutdown.addEventListener('abort', onAbort, { once: true })

    detachShutdown = () => shutdown.removeEventListener('abort', onAbort)
  })

  // Never rejects: an outcome is a value here, so a handler that throws is data
  // the loop records rather than an exception that ends the process.
  const work = (async (): Promise<CompletedOutcome | FailedOutcome> => {
    try {
      const result = await handler({ job, signal: controller.signal, log })
      return {
        outcome: 'completed',
        result: result ?? {},
        durationMs: Date.now() - started,
      }
    } catch (error) {
      return {
        outcome: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Date.now() - started,
      }
    }
  })()

  try {
    const settled = await Promise.race([work, interrupted])
    if (settled.outcome === 'timeout' || settled.outcome === 'abandoned') {
      return { ...settled, durationMs: Date.now() - started }
    }
    return settled
  } finally {
    clearTimeout(timeoutTimer)
    clearTimeout(graceTimer)
    detachShutdown?.()
  }
}

/** Record what happened, and say so. Never throws into the loop's wrong branch. */
async function recordOutcome(
  job: ScheduledJobRow,
  outcome: JobOutcome,
  log: JobLogger,
  summary: WorkerSummary,
): Promise<void> {
  switch (outcome.outcome) {
    case 'completed': {
      const row = await completeJob(job.id, outcome.result)
      summary.completed += 1
      log.info({
        event: 'worker.job-done',
        jobId: job.id,
        kind: job.type,
        durationMs: outcome.durationMs,
        // Null means the claim was taken away while the job ran — the work
        // happened twice, and the row now belongs to the other run.
        recorded: row !== null,
      })
      return
    }
    case 'failed': {
      const row = await failJob(job.id, outcome.error, {
        terminal: outcome.terminal === true,
      })
      summary.failed += 1
      log.error({
        event: 'worker.job-failed',
        jobId: job.id,
        kind: job.type,
        durationMs: outcome.durationMs,
        message: outcome.error.message,
        retrying: row?.status === 'pending',
        attempts: row?.attempts ?? job.attempts,
      })
      return
    }
    case 'timeout': {
      const row = await failJob(job.id, outcome.error)
      summary.failed += 1
      log.error({
        event: 'worker.job-timeout',
        jobId: job.id,
        kind: job.type,
        durationMs: outcome.durationMs,
        message: outcome.error.message,
        retrying: row?.status === 'pending',
      })
      return
    }
    case 'abandoned': {
      const row = await failJob(job.id, outcome.error)
      summary.failed += 1
      log.error({
        event: 'worker.job-abandoned',
        jobId: job.id,
        kind: job.type,
        durationMs: outcome.durationMs,
        message: outcome.error.message,
        retrying: row?.status === 'pending',
      })
      return
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Sleep, waking early when a shutdown is requested. */
/**
 * Wait, or stop waiting when a shutdown is requested.
 *
 * Exported for `./embedded`, which waits between attempts to start this loop and
 * has to be interruptible for the same reason: a supervisor that sleeps through
 * an abort delays a shutdown by the length of its sleep.
 */
export function sleep(ms: number, shutdown?: AbortSignal): Promise<void> {
  if (shutdown?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      shutdown?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    shutdown?.addEventListener('abort', done, { once: true })
  })
}

/** A message for a log line, from a value that may not be an `Error`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
