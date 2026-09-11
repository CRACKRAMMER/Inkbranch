import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { scheduledJobs, type ScheduledJobRow } from '@/lib/db/schema'
import type { JobKind } from './handlers'

/**
 * The durable job queue.
 *
 * One row in `scheduled_jobs` is one unit of work. This module is the only place
 * that enqueues, claims, completes or fails one; everything else reads.
 *
 * Claiming is a single statement — `UPDATE ... WHERE id = (SELECT ... FOR UPDATE
 * SKIP LOCKED LIMIT 1)`. The obvious alternative, reading a pending row and then
 * updating it, lets two workers read the same row and both believe they own it.
 * The duplicated work that follows is not merely wasteful: two publishers
 * rewriting the same file, or two full syncs racing, each delete the index rows
 * the other one just wrote.
 *
 * Not marked `server-only`: the worker runs under `tsx` outside Next.js, and
 * `server-only` is not a dependency of this project. Nothing here reaches a
 * client bundle anyway — it imports the database.
 */

/** Attempts a job gets when the caller does not ask for a different number. */
export const DEFAULT_MAX_ATTEMPTS = 5

/** First retry delay. Doubles per attempt, up to `RETRY_MAX_DELAY_MS`. */
export const RETRY_BASE_DELAY_MS = 30_000
export const RETRY_MAX_DELAY_MS = 30 * 60_000

/**
 * How long a claim is honoured before another worker may take the job.
 *
 * This is a lease, not a lock: it has to outlast the worker's per-job timeout,
 * or a worker still doing its job would have the row taken out from under it.
 * Measured against the application clock.
 */
export const CLAIM_STALE_MS = 15 * 60_000

/**
 * Longest error text stored on a row.
 *
 * `last_error` is `text`, so nothing truncates on the way in; the bound is here
 * because a stack trace on every failed attempt turns the admin's job list into
 * a wall of paths, and the useful part — what went wrong — is always at the
 * front. A driver error carrying a megabyte of query parameters is the other
 * half of the reason.
 */
export const MAX_ERROR_LENGTH = 500

/** Key the queue writes a handler's result under, inside `payload`. */
export const RESULT_KEY = 'result'

export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200

/** `locked_by` is 80 characters; a longer id would be rejected by Postgres. */
const LOCKED_BY_MAX_LENGTH = 80

export type JobStatus = ScheduledJobRow['status']

export class JobQueueError extends Error {
  readonly code = 'JOB_QUEUE'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JobQueueError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Pure decisions                                                             */
/* -------------------------------------------------------------------------- */

export interface RetryDecision {
  /** False when the job has used up its attempts and is now terminal. */
  retry: boolean
  /** When to run it again. Zero when `retry` is false. */
  delayMs: number
}

/**
 * Whether a failed job should be tried again, and how much later.
 *
 * `attempts` counts *starts*, not failures: `claimNextJob` increments it, so a
 * worker that dies mid-job still burns an attempt. Without that, a job that
 * crashes its worker would be retried forever by the next one.
 */
export function retryDecision(
  attempts: number,
  maxAttempts: number,
): RetryDecision {
  if (attempts >= maxAttempts) return { retry: false, delayMs: 0 }
  return { retry: true, delayMs: retryDelayMs(attempts) }
}

/** Exponential backoff, capped so a late attempt is not scheduled for next week. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(1, Math.floor(attempts)) - 1
  // `2 ** exponent` overflows to Infinity long before it matters; the cap is
  // applied after, so an absurd attempt count still yields a finite delay.
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS)
}

/**
 * Whether a `running` row's claim has gone cold.
 *
 * A row that is running with no `locked_at` counts as stale. Nothing is holding
 * it: a claim always stamps the time, so that shape only comes from a hand-edited
 * row or a bug, and treating it as live would strand the job permanently.
 *
 * The claim query in `claimNextJob` applies the same rule in SQL; this is the
 * reference implementation the tests exercise.
 */
export function isClaimStale(
  lockedAt: Date | null | undefined,
  now: Date,
  staleMs = CLAIM_STALE_MS,
): boolean {
  if (!lockedAt) return true
  return now.getTime() - lockedAt.getTime() > staleMs
}

/**
 * One line of error text, bounded.
 *
 * Newlines are collapsed rather than kept: the job list renders this as a
 * single row, and a multi-line value there is read as the first line anyway,
 * with the rest silently scrolled off.
 */
export function truncateError(
  message: string,
  max = MAX_ERROR_LENGTH,
): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/* -------------------------------------------------------------------------- */
/*  Enqueue                                                                    */
/* -------------------------------------------------------------------------- */

export interface EnqueueInput {
  type: JobKind
  payload?: Record<string, unknown>
  /** Earliest moment the job may be claimed. Defaults to now. */
  runAt?: Date
  /**
   * Collapses duplicates: at most one *pending* job per (type, dedupeKey) can
   * exist. A running job does not block a new one, so a job that is retried
   * after a failure is not silently dropped.
   */
  dedupeKey?: string
  maxAttempts?: number
}

/**
 * Add a job. Returns the new row, or null when an equivalent job is already
 * pending and this one was collapsed into it.
 */
export async function enqueue(
  job: EnqueueInput,
): Promise<ScheduledJobRow | null> {
  const [row] = await db
    .insert(scheduledJobs)
    .values({
      type: job.type,
      payload: job.payload ?? {},
      runAt: job.runAt ?? new Date(),
      dedupeKey: job.dedupeKey ?? null,
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    // The unique index behind this is partial — `where status = 'pending'` — so
    // the conflict target has to name the same predicate for Postgres to infer
    // it. Without the `where`, the statement fails outright rather than
    // deduplicating.
    .onConflictDoNothing({
      target: [scheduledJobs.type, scheduledJobs.dedupeKey],
      where: sql`${scheduledJobs.status} = 'pending'`,
    })
    .returning()

  return row ?? null
}

/* -------------------------------------------------------------------------- */
/*  Claim                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Take the next due job, atomically.
 *
 * Two workers calling this at the same instant get different rows: `SKIP
 * LOCKED` makes the second one pass over whatever the first has locked instead
 * of blocking behind it. `FOR UPDATE` inside the subquery is what holds the row
 * until the surrounding `UPDATE` commits — the lock, not the read, is what
 * makes the claim exclusive.
 *
 * A `running` row past its lease is claimable again, which is how a worker that
 * was killed mid-job gets its work picked up rather than leaving it stuck.
 */
export async function claimNextJob(
  workerId: string,
): Promise<ScheduledJobRow | null> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS)

  const [row] = await db
    .update(scheduledJobs)
    .set({
      status: 'running',
      lockedAt: sql`now()`,
      lockedBy: workerId.slice(0, LOCKED_BY_MAX_LENGTH),
      attempts: sql`${scheduledJobs.attempts} + 1`,
    })
    .where(sql`${scheduledJobs.id} = (
      select "id" from ${scheduledJobs}
      where (
        (${scheduledJobs.status} = 'pending' and ${scheduledJobs.runAt} <= now())
        or (
          ${scheduledJobs.status} = 'running'
          and (${scheduledJobs.lockedAt} is null or ${scheduledJobs.lockedAt} < ${staleBefore})
        )
      )
      order by ${scheduledJobs.runAt}, ${scheduledJobs.id}
      limit 1
      for update skip locked
    )`)
    .returning()

  return row ?? null
}

/* -------------------------------------------------------------------------- */
/*  Finish                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mark a job done and attach what the handler reported.
 *
 * The result goes into `payload` under `result`, because `scheduled_jobs` has no
 * result column and inventing a migration for one is a change this module is not
 * entitled to make. `||` merges rather than replaces, so the input the job was
 * enqueued with survives beside it.
 *
 * Returns null when the row was no longer running — a claim taken away by the
 * stale-lease sweep lands here, and the caller should know the work was done
 * twice rather than believe it recorded the only copy.
 */
export async function completeJob(
  id: string,
  result: Record<string, unknown>,
): Promise<ScheduledJobRow | null> {
  const patch = JSON.stringify({ [RESULT_KEY]: result })

  const [row] = await db
    .update(scheduledJobs)
    .set({
      status: 'done',
      finishedAt: new Date(),
      lastError: null,
      payload: sql`${scheduledJobs.payload} || ${patch}::jsonb`,
    })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, 'running')))
    .returning()

  return row ?? null
}

export interface FailJobOptions {
  /**
   * Fail regardless of remaining attempts. For errors that trying again cannot
   * fix — a job kind with no handler, a payload the handler cannot read — where
   * retrying only delays a job that will never succeed.
   */
  terminal?: boolean
}

/**
 * Record a failure: retry with backoff, or make the job terminal.
 *
 * Read and write happen under `FOR UPDATE`, because the decision depends on the
 * row's attempt count and two failures could otherwise race — a job whose lease
 * expired while its original worker was still alive can be failed by both the
 * old worker and the new one. The lock serialises those into one retry step
 * each, which is the most either can honestly claim.
 */
export async function failJob(
  id: string,
  error: unknown,
  options: FailJobOptions = {},
): Promise<ScheduledJobRow | null> {
  const message = truncateError(errorMessage(error))
  const terminal = options.terminal === true

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, id))
      .for('update')
      .limit(1)

    if (!current || current.status !== 'running') return null

    const decision = terminal
      ? { retry: false, delayMs: 0 }
      : retryDecision(current.attempts, current.maxAttempts)

    const [row] = await tx
      .update(scheduledJobs)
      .set({
        lastError: message,
        ...(decision.retry
          ? {
              // Back to the queue, with the claim released so any worker can
              // take it.
              status: 'pending' as const,
              runAt: new Date(Date.now() + decision.delayMs),
              lockedAt: null,
              lockedBy: null,
            }
          : {
              status: 'failed' as const,
              finishedAt: new Date(),
              // `locked_at` and `locked_by` are left alone: which worker last
              // ran it is the only provenance a failed row has.
            }),
      })
      .where(eq(scheduledJobs.id, id))
      .returning()

    return row ?? null
  })
}

/* -------------------------------------------------------------------------- */
/*  Read                                                                       */
/* -------------------------------------------------------------------------- */

export interface ListJobsOptions {
  status?: JobStatus | readonly JobStatus[]
  limit?: number
}

/** Most recently created first, which is the order the admin lists them in. */
export async function listJobs(
  options: ListJobsOptions = {},
): Promise<ScheduledJobRow[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT), 1),
    MAX_LIST_LIMIT,
  )
  const statuses =
    options.status === undefined
      ? []
      : Array.isArray(options.status)
        ? options.status
        : [options.status as JobStatus]

  return db
    .select()
    .from(scheduledJobs)
    .where(
      statuses.length > 0
        ? inArray(scheduledJobs.status, statuses)
        : undefined,
    )
    .orderBy(desc(scheduledJobs.createdAt))
    .limit(limit)
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    // A value that cannot be serialised (a cycle, a BigInt) still has to produce
    // something a reader can act on, and `String` cannot throw.
    return String(error)
  }
}
