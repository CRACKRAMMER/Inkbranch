import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { scheduledJobs } from '@/lib/db/schema'
import {
  CLAIM_STALE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ERROR_LENGTH,
  RESULT_KEY,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  isClaimStale,
  listJobs,
  retryDecision,
  retryDelayMs,
  truncateError,
} from '@/lib/jobs/queue'
import {
  JOB_KINDS,
  isKnownJobKind,
  isPublishDue,
  jobHandlers,
  resolveHandler,
} from '@/lib/jobs/handlers'
import { hasTestDatabase } from '../setup'

/**
 * The job queue.
 *
 * The decisions that a queue gets wrong are the ones nothing else notices until
 * the queue stops draining — which job a worker may take, when a failure stops
 * being retried, how long a dead worker's claim is honoured — so they live as
 * pure functions and are tested here, without a database.
 *
 * The database-backed half runs only when `TEST_DATABASE_URL` is set, because
 * the alternative is a suite that fails on every machine without Postgres and
 * gets deleted by the second person who runs it.
 */

describe('job kind registry', () => {
  it('has a handler for every kind it declares', () => {
    for (const kind of JOB_KINDS) {
      expect(isKnownJobKind(kind)).toBe(true)
      expect(resolveHandler(kind)).toBeTypeOf('function')
    }
    // The registry and the list are the same set, in either direction: a kind
    // with no handler would be a job nothing can run, and a handler with no kind
    // would be dead code.
    expect(Object.keys(jobHandlers).sort()).toEqual([...JOB_KINDS].sort())
  })

  it('rejects a kind nothing implements', () => {
    expect(isKnownJobKind('content.explode')).toBe(false)
    expect(resolveHandler('content.explode')).toBeNull()
  })

  it('leaves the kinds whose modules do not exist out of the registry', () => {
    // `src/lib/analytics` and an asset-cleanup entry point do not exist yet. A
    // handler that reported an aggregation it never ran would be worse than a
    // kind that cannot be enqueued, so they are absent on purpose — and this
    // expectation is what fails, loudly, on the day one of them lands.
    for (const kind of ['analytics.aggregate', 'analytics.prune', 'assets.cleanup']) {
      expect(isKnownJobKind(kind)).toBe(false)
      expect(resolveHandler(kind)).toBeNull()
    }
  })
})

describe('retry decision', () => {
  it('retries with a doubling delay until the attempts are used up', () => {
    expect(retryDecision(1, 5)).toEqual({
      retry: true,
      delayMs: RETRY_BASE_DELAY_MS,
    })
    expect(retryDecision(2, 5)).toEqual({
      retry: true,
      delayMs: RETRY_BASE_DELAY_MS * 2,
    })
    expect(retryDecision(3, 5)).toEqual({
      retry: true,
      delayMs: RETRY_BASE_DELAY_MS * 4,
    })
    expect(retryDecision(4, 5).retry).toBe(true)

    // The last attempt is the last attempt: five of five starts used means the
    // job is terminal, not that it gets a sixth.
    expect(retryDecision(5, 5)).toEqual({ retry: false, delayMs: 0 })
    expect(retryDecision(6, 5)).toEqual({ retry: false, delayMs: 0 })
  })

  it('gives a job that has never run the first delay', () => {
    expect(retryDecision(0, DEFAULT_MAX_ATTEMPTS)).toEqual({
      retry: true,
      delayMs: RETRY_BASE_DELAY_MS,
    })
  })

  it('caps the delay instead of scheduling an attempt for next week', () => {
    // Doubling runs out of room at 30s * 2^6; the attempt after that is capped.
    expect(retryDelayMs(6)).toBe(RETRY_BASE_DELAY_MS * 32)
    expect(retryDelayMs(7)).toBe(RETRY_MAX_DELAY_MS)
    expect(retryDelayMs(100)).toBe(RETRY_MAX_DELAY_MS)
    expect(retryDelayMs(1_000_000)).toBe(RETRY_MAX_DELAY_MS)
    expect(retryDelayMs(5)).toBeLessThan(retryDelayMs(6))
  })
})

describe('failure message', () => {
  it('keeps a message that fits', () => {
    const message = 'connect ECONNREFUSED 127.0.0.1:55432'
    expect(truncateError(message)).toBe(message)
  })

  it('cuts a stack trace down to one bounded line', () => {
    const stack = [
      'Error: boom',
      '    at publishDocument (/app/src/lib/jobs/handlers.ts:1:1)',
      `    at ${'x'.repeat(4000)}`,
    ].join('\n')

    const stored = truncateError(stack)

    expect(stored.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH)
    expect(stored).not.toContain('\n')
    // What went wrong is at the front and survives; the frames are what is lost.
    expect(stored.startsWith('Error: boom at publishDocument')).toBe(true)
    expect(stored.endsWith('…')).toBe(true)
  })

  it('leaves a message of exactly the limit alone', () => {
    const exact = 'y'.repeat(MAX_ERROR_LENGTH)
    expect(truncateError(exact)).toBe(exact)
    expect(truncateError(`${exact}z`).length).toBeLessThanOrEqual(
      MAX_ERROR_LENGTH,
    )
  })

  it('handles a message that is only whitespace', () => {
    expect(truncateError('')).toBe('')
    expect(truncateError('  \n\t ')).toBe('')
  })
})

describe('stale claim predicate', () => {
  const now = new Date('2026-09-11T12:00:00.000Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('treats a fresh claim as live', () => {
    expect(isClaimStale(ago(1_000), now)).toBe(false)
    expect(isClaimStale(ago(CLAIM_STALE_MS - 1), now)).toBe(false)
    // Exactly at the lease boundary the claim is still live, mirroring the
    // `locked_at <` comparison in the claim query rather than a `<=`.
    expect(isClaimStale(ago(CLAIM_STALE_MS), now)).toBe(false)
  })

  it('claims a row whose worker is past its lease', () => {
    expect(isClaimStale(ago(CLAIM_STALE_MS + 1), now)).toBe(true)
    expect(isClaimStale(ago(CLAIM_STALE_MS * 10), now)).toBe(true)
  })

  it('claims a running row that carries no lock timestamp', () => {
    // A claim always stamps the time, so this shape is a hand-edited row or a
    // bug. Nothing is holding it, and pretending otherwise strands the job
    // forever.
    expect(isClaimStale(null, now)).toBe(true)
    expect(isClaimStale(undefined, now)).toBe(true)
  })

  it('does not claim a row timestamped in the future', () => {
    expect(isClaimStale(new Date(now.getTime() + 60_000), now)).toBe(false)
  })
})

describe('scheduled publish predicate', () => {
  const now = new Date('2026-09-11T12:00:00.000Z')
  const at = (ms: number) => new Date(now.getTime() + ms)

  it('publishes a document whose moment has passed', () => {
    expect(isPublishDue({ status: 'scheduled', scheduledAt: at(-1) }, now)).toBe(
      true,
    )
    expect(
      isPublishDue({ status: 'scheduled', scheduledAt: at(-86_400_000) }, now),
    ).toBe(true)
  })

  it('publishes a document whose moment is exactly now', () => {
    // The boundary is inclusive: a document scheduled for this second goes live
    // on this run, not the next one.
    expect(
      isPublishDue({ status: 'scheduled', scheduledAt: new Date(now.getTime()) }, now),
    ).toBe(true)
  })

  it('leaves a document whose moment has not arrived', () => {
    expect(isPublishDue({ status: 'scheduled', scheduledAt: at(1) }, now)).toBe(
      false,
    )
    expect(
      isPublishDue({ status: 'scheduled', scheduledAt: at(86_400_000) }, now),
    ).toBe(false)
  })

  it('leaves a document that is not scheduled', () => {
    for (const status of ['draft', 'published', 'archived'] as const) {
      expect(isPublishDue({ status, scheduledAt: at(-1_000) }, now)).toBe(false)
    }
  })

  it('leaves a scheduled document with no moment', () => {
    // The frontmatter schema refuses `status: scheduled` without `publishAt`,
    // so this is a row edited in SQL. Publishing it would be publishing a
    // document that never asked for a moment.
    expect(isPublishDue({ status: 'scheduled', scheduledAt: null }, now)).toBe(
      false,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Database-backed                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Runs only with a real database. These are the claims the queue makes to the
 * rest of the system — that two workers never get the same job, that a dead
 * worker's job comes back, that attempts run out — and they are enforced by SQL
 * that the pure tests above cannot see.
 */
describe.runIf(hasTestDatabase)('queue against Postgres', () => {
  /** Unique per run, so cleanup touches nothing another suite created. */
  const marker = `jobs-test-${process.pid}-${Date.now().toString(36)}`

  const cleanup = () =>
    db.delete(scheduledJobs).where(
      sql`${scheduledJobs.payload}->>'marker' = ${marker}`,
    )

  afterAll(async () => {
    await cleanup()
  })

  async function enqueueTestJob(dedupeKey: string) {
    return enqueue({
      type: 'content.sync',
      payload: { marker },
      dedupeKey,
    })
  }

  it('claims a job once and records what the handler reported', async () => {
    const queued = await enqueueTestJob(`${marker}-once`)
    expect(queued).not.toBeNull()

    const claimed = await claimNextJob(`${marker}-worker-a`)
    expect(claimed?.id).toBe(queued?.id)
    expect(claimed?.status).toBe('running')
    // The attempt is counted at claim time, so a worker that dies mid-job still
    // burns one.
    expect(claimed?.attempts).toBe(1)

    const done = await completeJob(claimed!.id, { scanned: 3, added: 1 })
    expect(done?.status).toBe('done')
    expect(done?.finishedAt).toBeInstanceOf(Date)
    expect(done?.payload[RESULT_KEY]).toEqual({ scanned: 3, added: 1 })
    // The input payload survives beside the result.
    expect(done?.payload.marker).toBe(marker)

    // Nothing of mine is left to claim.
    const mine = await listJobs({ status: 'pending' })
    expect(mine.some((row) => row.id === claimed!.id)).toBe(false)
  })

  it('collapses a duplicate enqueue onto the pending job', async () => {
    const key = `${marker}-dedupe`
    const first = await enqueueTestJob(key)
    const second = await enqueueTestJob(key)

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('never hands one job to two workers', async () => {
    const created = await Promise.all(
      [0, 1, 2].map((index) => enqueueTestJob(`${marker}-race-${index}`)),
    )
    const mine = new Set(created.map((row) => row?.id))

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        claimNextJob(`${marker}-worker-${index}`),
      ),
    )

    const claimedIds = claims
      .map((row) => row?.id)
      .filter((id): id is string => id !== undefined)

    expect(new Set(claimedIds).size).toBe(claimedIds.length)
    // Rows another suite left behind may be claimed too; what matters is that
    // this test's jobs were handed out at most once, which the line above
    // settles for every row including those.
    expect(claimedIds.some((id) => mine.has(id))).toBe(true)
  })

  it('reclaims a job whose worker stopped reporting', async () => {
    // A claim older than the lease, exactly as a killed worker leaves it.
    const [abandoned] = await db
      .insert(scheduledJobs)
      .values({
        type: 'content.sync',
        status: 'running',
        payload: { marker },
        attempts: 1,
        lockedAt: new Date(Date.now() - CLAIM_STALE_MS - 60_000),
        lockedBy: `${marker}-dead-worker`,
      })
      .returning()

    const claimed = await claimUntil(abandoned!.id)

    expect(claimed?.id).toBe(abandoned?.id)
    expect(claimed?.lockedBy).toBe(`${marker}-reviver`)
    expect(claimed?.attempts).toBe(2)
  })

  it('stops retrying once the attempts are used up', async () => {
    const [exhausted] = await db
      .insert(scheduledJobs)
      .values({
        type: 'content.sync',
        status: 'running',
        payload: { marker },
        attempts: 2,
        maxAttempts: 2,
        lockedAt: new Date(),
        lockedBy: `${marker}-worker-fail`,
      })
      .returning()

    const failed = await failJob(exhausted!.id, new Error('boom\n    at x'))
    expect(failed?.status).toBe('failed')
    expect(failed?.lastError).toBe('boom at x')
    expect(failed?.finishedAt).toBeInstanceOf(Date)

    const [retryable] = await db
      .insert(scheduledJobs)
      .values({
        type: 'content.sync',
        status: 'running',
        payload: { marker },
        attempts: 1,
        maxAttempts: 3,
        lockedAt: new Date(),
        lockedBy: `${marker}-worker-fail`,
      })
      .returning()

    const requeued = await failJob(retryable!.id, new Error('transient'))
    expect(requeued?.status).toBe('pending')
    expect(requeued?.lockedAt).toBeNull()
    expect(requeued?.lockedBy).toBeNull()
    expect(requeued?.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  /**
   * Claim until this test's row comes up.
   *
   * `claimNextJob` takes the oldest due job in the table, and a database shared
   * with other suites may hold rows this test did not create. Foreign rows are
   * left claimed — harmless, since a claim expires on its own — rather than
   * being failed back into the queue, which would be this test writing to
   * someone else's fixture.
   */
  async function claimUntil(id: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await claimNextJob(`${marker}-reviver`)
      if (!row) return null
      if (row.id === id) return row
    }
    return null
  }
})
