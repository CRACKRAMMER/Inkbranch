import { gunzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { env } from '@/env'
import { MAX_AGGREGATE_DAYS_PER_RUN } from '@/lib/analytics/aggregate'
import { addDays, dayStart, utcDay } from '@/lib/analytics/day'
import { db } from '@/lib/db'
import {
  analyticsDaily,
  analyticsEvents,
  assets,
  auditLogs,
  contentIndex,
  contentRevisions,
  scheduledJobs,
} from '@/lib/db/schema'
import { buildRelativePath } from '@/lib/content/paths'
import { parseFrontmatter, serializeFrontmatter } from '@/lib/content/frontmatter'
import { readDocument } from '@/lib/content/reader'
import { syncOneDocument } from '@/lib/content/sync'
import { writeRawDocument } from '@/lib/content/writer'
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
  jobStatusCounts,
  listJobs,
  pruneFinishedJobs,
  retryDecision,
  retryDelayMs,
  truncateError,
} from '@/lib/jobs/queue'
import {
  JOB_KINDS,
  JobHandlerError,
  isKnownJobKind,
  isPublishDue,
  jobHandlers,
  resolveHandler,
  type JobKind,
  type JobLogger,
  type JobLogEvent,
  type JobResult,
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

  it('registers the housekeeping kinds, which nothing else would notice losing', () => {
    // These three were absent until their modules existed, and the expectation
    // that they were absent is what failed on the day they landed. It is kept
    // as a list because of what they have in common: nothing on a page depends
    // on them, so a kind that quietly disappeared from the registry would take
    // scheduled publishing or analytics rollups with it and the site would go
    // on serving, looking fine, with the work silently never done.
    for (const kind of [
      'analytics.aggregate',
      'analytics.prune',
      'assets.orphan-scan',
    ] as const) {
      expect(isKnownJobKind(kind)).toBe(true)
      expect(resolveHandler(kind)).toBeTypeOf('function')
    }
  })

  it('has no kind that deletes an asset', () => {
    // The orphan scan reports and never deletes. The set it would delete
    // against is derived — a page that is currently failing to render leaves
    // its images looking unreferenced — so a handler that acted on it would
    // remove files that published pages still point at. That decision is worth
    // an assertion, because the next person to see an orphan-scan report will
    // be tempted to write exactly this kind.
    for (const kind of ['assets.cleanup', 'assets.prune', 'assets.delete']) {
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

  /**
   * The difference between counting the queue and counting its window.
   *
   * `listJobs` returns the most recently created rows, and the dashboard's
   * figures come from `jobStatusCounts` for exactly the case this test builds:
   * a job old enough to have fallen out of the window is the job a person needs
   * to see, and a count of the window reports it as gone.
   */
  it('counts the queue itself, where the list returns a window of it', async () => {
    const before = await jobStatusCounts()

    // Two, so the window cannot hold both however it is ordered: the assertion
    // below is about a job the window drops, not about which job it keeps.
    const first = await enqueueTestJob(`${marker}-window-a`)
    const second = await enqueueTestJob(`${marker}-window-b`)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const window = await listJobs({ limit: 1 })
    const openInWindow = window.filter((job) => job.status === 'pending').length
    const after = await jobStatusCounts()

    expect(after.pending - before.pending).toBe(2)
    expect(openInWindow).toBeLessThan(after.pending - before.pending)

    /*
     * Removed before the test ends, and this is not tidiness. Two pending rows
     * with an earlier `run_at` than anything the next test queues are two rows
     * `claimNextJob` hands to it — the claim is the oldest due job in the table,
     * not the one the caller just wrote — and the test after this one asserts on
     * the job it enqueued. Leaving them behind fails a test that has nothing to
     * do with this one, which is what happened when this test was written.
     */
    await db
      .delete(scheduledJobs)
      .where(inArray(scheduledJobs.id, [first!.id, second!.id]))
  })

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

  it('prunes finished jobs past the retention window, and nothing else', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const old = new Date(Date.now() - 30 * DAY_MS)
    const recent = new Date(Date.now() - 1_000)

    const [finishedLongAgo, failedLongAgo, neverRanOld] = await db
      .insert(scheduledJobs)
      .values([
        { type: 'content.sync', status: 'done', payload: { marker }, attempts: 1, createdAt: old, finishedAt: old },
        { type: 'content.sync', status: 'failed', payload: { marker }, attempts: 3, createdAt: old, finishedAt: old },
        // Finished, but with no `finished_at` — a row written by an older
        // version, or edited by hand. Its creation time is what it is judged by.
        { type: 'content.sync', status: 'done', payload: { marker }, attempts: 1, createdAt: old },
      ])
      .returning()

    // Everything this prune must leave alone, whatever the window is.
    const [finishedRecently, stillPending, stillRunning] = await db
      .insert(scheduledJobs)
      .values([
        { type: 'content.sync', status: 'done', payload: { marker }, attempts: 1, createdAt: recent, finishedAt: recent },
        { type: 'content.sync', status: 'pending', payload: { marker }, createdAt: old },
        {
          type: 'content.sync',
          status: 'running',
          payload: { marker },
          attempts: 1,
          createdAt: old,
          lockedAt: new Date(),
          lockedBy: `${marker}-running`,
        },
      ])
      .returning()

    const survivors = async () =>
      (
        await db
          .select({ id: scheduledJobs.id })
          .from(scheduledJobs)
          .where(
            inArray(scheduledJobs.id, [
              finishedLongAgo!.id,
              failedLongAgo!.id,
              neverRanOld!.id,
              finishedRecently!.id,
              stillPending!.id,
              stillRunning!.id,
            ]),
          )
      )
        .map((row) => row.id)
        .sort()

    const protectedIds = [finishedRecently!.id, stillPending!.id, stillRunning!.id].sort()

    // One row at a time, so the cap is a cap: a first run against a table that
    // has never been pruned makes progress rather than holding a lock for as
    // long as the backlog takes.
    const first = await pruneFinishedJobs({ olderThanDays: 7, limit: 1 })
    expect(first.deleted).toBe(1)
    expect(first.more).toBe(true)

    const second = await pruneFinishedJobs({ olderThanDays: 7, limit: 1_000 })
    expect(second.deleted).toBeGreaterThanOrEqual(2)

    // The three that were old and finished are gone; the one that never ran,
    // the one that ran a moment ago and the one still claimed are not.
    expect(await survivors()).toEqual(protectedIds)
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

/* -------------------------------------------------------------------------- */
/*  Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three handlers that only a timer ever calls.
 *
 * They are tested together because of what they have in common, which is also
 * what makes them worth testing at all: nothing on a page waits for them. If
 * one stopped working the site would go on serving and look entirely healthy
 * while scheduled posts never appeared, the dashboard's numbers quietly stopped
 * moving and the job reported success every interval.
 *
 * Each one is called through `resolveHandler`, so the test covers the wiring as
 * well as the work — a handler registered under the wrong kind, or registered
 * nowhere, fails here rather than in production.
 */
describe.runIf(hasTestDatabase)('handlers against Postgres', () => {
  const marker = `housekeeping-${process.pid}-${Date.now().toString(36)}`
  /** Paths this suite created, so cleanup touches nothing else. */
  const PATH_PREFIX = `/__jobs_test__/${marker}/`
  /** Job rows this suite created, for the same reason. */
  const created = new Set<string>()

  /**
   * Content files and index rows these tests created.
   *
   * The content root is a temp directory the setup file makes per test file, so
   * the files need no cleanup — but the index rows do not live there, and a
   * document left in `content_index` would be visible to every other suite that
   * queries it. The revisions cascade from the row; the audit rows do not,
   * because they are deliberately independent of what they describe, so the
   * publish test removes its own.
   */
  const createdPaths: string[] = []
  const createdContentIds: string[] = []

  afterAll(async () => {
    if (created.size > 0) {
      await db.delete(scheduledJobs).where(inArray(scheduledJobs.id, [...created]))
    }
    await db.delete(analyticsEvents).where(like(analyticsEvents.path, `${PATH_PREFIX}%`))
    await db.delete(analyticsDaily).where(like(analyticsDaily.path, `${PATH_PREFIX}%`))
    if (createdPaths.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.targetId, createdPaths))
    }
    if (createdContentIds.length > 0) {
      await db
        .delete(contentIndex)
        .where(inArray(contentIndex.id, createdContentIds))
    }
  })

  interface RecordedLog {
    info: JobLogEvent[]
    error: JobLogEvent[]
    logger: JobLogger
  }

  /** A logger that keeps what it was told, so the log is asserted on too. */
  function recordingLogger(): RecordedLog {
    const info: JobLogEvent[] = []
    const error: JobLogEvent[] = []
    return {
      info,
      error,
      logger: {
        info: (event) => info.push(event),
        error: (event) => error.push(event),
      },
    }
  }

  const names = (events: JobLogEvent[]): unknown[] => events.map((event) => event.event)

  /**
   * Run a handler exactly the way the worker does.
   *
   * The row is inserted rather than built by hand: handlers receive a
   * `ScheduledJobRow`, and a literal would be this suite's idea of the shape
   * rather than the database's.
   */
  async function runJob(
    type: JobKind,
    payload: Record<string, unknown> = {},
  ): Promise<{ result: JobResult; log: RecordedLog }> {
    const [job] = await db
      .insert(scheduledJobs)
      .values({
        type,
        status: 'running',
        payload,
        attempts: 1,
        lockedAt: new Date(),
        lockedBy: `${marker}-worker`,
      })
      .returning()

    created.add(job!.id)

    const handler = resolveHandler(type)
    if (!handler) throw new Error(`No handler registered for ${type}`)

    const log = recordingLogger()
    const result = await handler({
      job: job!,
      signal: new AbortController().signal,
      log: log.logger,
    })

    return { result, log }
  }

  async function insertEvent(day: string, path: string): Promise<void> {
    await db.insert(analyticsEvents).values({
      path,
      visitorHash: 'housekeeping',
      device: 'desktop',
      referrerDomain: '',
      contentId: null,
      createdAt: new Date(dayStart(day).getTime() + 60_000),
    })
  }

  async function eventCount(day: string): Promise<number> {
    const rows = await db
      .select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.path, `${PATH_PREFIX}withheld`), sql`to_char(${analyticsEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD') = ${day}`))
    return rows.length
  }

  describe('analytics.aggregate', () => {
    /**
     * Days far enough in the past that no sweep looks at them.
     *
     * The sweep is driven by a payload naming days, and running a real one
     * would aggregate whatever the real clock's retention window covers —
     * including rows another suite seeded for the present day.
     */
    const DAY = '2022-03-01'
    const QUIET_DAY = '2022-03-02'

    async function clear(): Promise<void> {
      for (const day of [DAY, QUIET_DAY]) {
        await db.delete(analyticsDaily).where(eq(analyticsDaily.day, day))
        await db.execute(sql`
          delete from ${analyticsEvents}
          where to_char(${analyticsEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD') = ${day}
            and ${analyticsEvents.path} like ${`${PATH_PREFIX}%`}
        `)
      }
    }

    it('rebuilds the days a payload names, and reports the ones with nothing', async () => {
      await clear()
      await insertEvent(DAY, `${PATH_PREFIX}named`)
      await insertEvent(DAY, `${PATH_PREFIX}named`)

      const { result, log } = await runJob('analytics.aggregate', {
        days: [QUIET_DAY, DAY, DAY],
      })

      // Deduplicated and sorted, so the same list cannot be counted twice or
      // aggregated in an order the caller guessed at.
      expect(result.requested).toEqual([DAY, QUIET_DAY])
      expect(result.aggregated).toEqual([DAY])
      expect(result.empty).toEqual([QUIET_DAY])
      expect(result.deferred).toEqual([])
      expect(result.views).toBe(2)
      expect(result.rows).toBe(1)

      expect(names(log.info)).toContain('job.analytics-aggregate')
      // Nothing was left behind, so there is nothing for an operator to act on.
      expect(names(log.error)).not.toContain('job.analytics-aggregate.behind')
    })

    it('takes the oldest days and defers the rest of a long list', async () => {
      // A caller with more days than one run will do is given the oldest batch,
      // and told what waited. The alternative — aggregating all of it in one
      // run, or dropping the remainder — is either a long lock or silent loss.
      const days = Array.from({ length: MAX_AGGREGATE_DAYS_PER_RUN + 4 }, (_, index) =>
        addDays('2022-04-01', index),
      )

      const { result, log } = await runJob('analytics.aggregate', { days })

      // `requested` is what this run took on, not what the payload held: the
      // two together are the caller's list, and neither is counted twice.
      expect(result.requested).toEqual(days.slice(0, MAX_AGGREGATE_DAYS_PER_RUN))
      expect(result.empty).toEqual(days.slice(0, MAX_AGGREGATE_DAYS_PER_RUN))
      expect(result.deferred).toEqual(days.slice(MAX_AGGREGATE_DAYS_PER_RUN))
      // Deferral is not a failure, but it is the one thing an operator can act
      // on, so it is reported at a level that shows up.
      expect(names(log.error)).toContain('job.analytics-aggregate.behind')
    })

    it('refuses a payload it cannot read instead of sweeping instead', async () => {
      // "Aggregate these forty days" and "aggregate whatever looks behind" cost
      // the same and mean different things. A payload bug that silently ran the
      // wrong one would be invisible until someone compared the dashboard
      // against the traffic.
      for (const days of ['yesterday', [], ['not-a-day'], [7], null]) {
        await expect(runJob('analytics.aggregate', { days })).rejects.toThrow(
          JobHandlerError,
        )
        await expect(runJob('analytics.aggregate', { days })).rejects.toThrow(/days/)
      }
    })

    it('finds the days that are behind without being told which', async () => {
      // Yesterday rather than a fixture day: the sweep works out what is behind
      // from the tables, and yesterday is the one day it always has an opinion
      // about whatever the retention window is set to.
      const yesterday = addDays(utcDay(), -1)
      const path = `${PATH_PREFIX}swept`
      await db.delete(analyticsEvents).where(eq(analyticsEvents.path, path))
      await db.delete(analyticsDaily).where(eq(analyticsDaily.path, path))
      await insertEvent(yesterday, path)

      const { result, log } = await runJob('analytics.aggregate')

      expect(result.requested).toBeNull()
      expect(result.aggregated).toContain(yesterday)

      const rows = await db
        .select({ views: analyticsDaily.views })
        .from(analyticsDaily)
        .where(and(eq(analyticsDaily.day, yesterday), eq(analyticsDaily.path, path)))

      expect(rows).toEqual([{ views: 1 }])
      expect(names(log.info)).toContain('job.analytics-aggregate')
    })
  })

  describe('analytics.prune', () => {
    it('hands the days it had to withhold to an aggregation job', async () => {
      // A day past the window whose events are the only copy of it. Retention
      // refuses to delete it — the next run would too — so it is handed to the
      // job that gives it a copy in `analytics_daily`, and only then deleted.
      const day = addDays(utcDay(), -(env.ANALYTICS_RAW_RETENTION_DAYS + 45))
      await db.delete(analyticsEvents).where(eq(analyticsEvents.path, `${PATH_PREFIX}withheld`))
      await insertEvent(day, `${PATH_PREFIX}withheld`)

      // A leftover from an interrupted run would make the enqueue below a
      // no-op — the dedupe key collapses onto the pending row — and the
      // assertion would then be about that row rather than the one this run
      // created, which is a test passing for the wrong reason.
      await db
        .delete(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.type, 'analytics.aggregate'),
            sql`${scheduledJobs.payload}->>'reason' = 'retention-withheld'`,
          ),
        )

      const { result, log } = await runJob('analytics.prune')

      const id = result.aggregateJobId
      expect(typeof id).toBe('string')
      // Registered for cleanup here rather than at the end: a failure in
      // between would leave a pending job in this database, and the next run's
      // `claimNextJob` — which takes the oldest due row — would claim that one
      // instead of its own fixture.
      created.add(id as string)

      const [queued] = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, id as string))

      expect(queued?.type).toBe('analytics.aggregate')
      expect(queued?.status).toBe('pending')
      expect(queued?.payload.days).toContain(day)
      expect(queued?.payload.reason).toBe('retention-withheld')

      // The point of withholding, asserted where it matters: the events that
      // are the only copy of that day are still there.
      expect(await eventCount(day)).toBe(1)

      // Not a failure — the job did what it could — but aggregation is behind,
      // which is the one thing an operator can do something about.
      expect(names(log.error)).toContain('job.analytics-prune.withheld')
      expect(names(log.info)).toContain('job.analytics-prune')
    })
  })

  describe('assets.orphan-scan', () => {
    it('reports what nothing points at, and deletes none of it', async () => {
      const before = await db.select({ id: assets.id }).from(assets)

      const { result, log } = await runJob('assets.orphan-scan')

      expect(typeof result.found).toBe('number')
      expect(typeof result.truncated).toBe('boolean')

      const sample = result.sample as { id: string; path: string; bytes: number }[]
      expect(Array.isArray(sample)).toBe(true)
      // The count is the full figure and the sample is capped, because this
      // ends up in a `jsonb` column of the job row.
      expect(sample.length).toBe(Math.min(result.found as number, 20))

      // The decision this job exists to express: what counts as a reference is
      // derived, so a tree that has not been synced makes every asset in it
      // look unreferenced. Acting on that deletes files published pages still
      // point at, so the job reports and a human decides.
      expect(await db.select({ id: assets.id }).from(assets)).toHaveLength(before.length)

      expect(names(log.info)).toContain('job.assets-orphan-scan')
    })
  })

  describe('content.publish-scheduled', () => {
    /**
     * A document whose moment has passed, on disk and in the index.
     *
     * Written as raw text through `writeRawDocument` rather than built by
     * `createDocument`, because the point of the fixture is the frontmatter
     * exactly as a file would carry it — a `publishAt` in the past and
     * `status: scheduled` — and the sync is what has to read that back as a
     * scheduled document.
     */
    async function scheduledDocument(slug: string, publishAt: string) {
      const path = buildRelativePath('post', slug)
      await writeRawDocument(
        path,
        serializeFrontmatter(
          {
            title: slug,
            description: 'A scheduled fixture written by the job suite.',
            date: publishAt,
            status: 'scheduled',
            publishAt,
          },
          'The body a scheduled publish leaves alone.',
        ),
      )

      const synced = await syncOneDocument(path)
      if (!synced) throw new Error(`The fixture at ${path} did not sync`)
      // The precondition every assertion below depends on: a document the
      // handler will consider due. Without this the suite would pass by
      // publishing nothing.
      expect(synced.row.status).toBe('scheduled')
      expect(synced.row.scheduledAt).not.toBeNull()

      createdPaths.push(path)
      createdContentIds.push(synced.row.id)
      return { path, row: synced.row }
    }

    it('publishes a due document, and keeps what it replaced', async () => {
      const slug = `${marker}-due`
      const publishAt = new Date(Date.now() - 60_000).toISOString()
      const { path, row } = await scheduledDocument(slug, publishAt)

      const { result } = await runJob('content.publish-scheduled')

      expect(result.published).toContain(path)

      // The file is what changed: `status` is a frontmatter key and the index
      // is derived from it, so a row flipped on its own would be overwritten
      // by the next sync.
      const written = await readDocument(path)
      expect(written?.status).toBe('published')

      /*
       * The revision. §19 says every formal save leaves one, and a scheduled
       * publish is a save — the one nobody is watching. The state it replaced
       * is the scheduled draft, which exists nowhere else once this returns.
       */
      const revisions = await db
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.contentId, row.id))

      expect(revisions).toHaveLength(1)
      expect(revisions[0]?.summary).toBe('Published')
      expect(revisions[0]?.authorId).toBeNull()

      // The snapshot is the scheduled state and not the published one: proving
      // it round-trips is the whole point of storing it. Asserted on the parsed
      // value rather than on the text, because the serialiser chooses the
      // quoting and a test that pinned `status: scheduled` would fail the day it
      // decided to quote the string.
      const snapshot = parseFrontmatter(
        gunzipSync(revisions[0]!.snapshot).toString('utf8'),
      )
      expect(snapshot.data.status).toBe('scheduled')
      expect(snapshot.content).toContain('The body a scheduled publish leaves alone.')

      /*
       * And the stats are one line rewritten, nothing else — not
       * `toBeGreaterThan(0)`, which a recompute that dropped the body would also
       * satisfy while reporting a diff of the whole file. The failure pinned
       * here is a capture describing a change other than the one that happened.
       *
       * The exact numbers are worth knowing: the write also adds a
       * `# Published on schedule` comment line, which this does not count,
       * because `captureRevision` reconstructs the written text from the
       * frontmatter and never sees the comment. That is the "off by a line" its
       * own doc comment warns about, and it is bounded — the fixture is written
       * in the canonical serialisation, so nothing else can show up as churn.
       */
      expect(revisions[0]?.additions).toBe(1)
      expect(revisions[0]?.deletions).toBe(1)

      // §34: the operation is in the audit log, with no actor, because a job is
      // not a person.
      const audit = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'post.publish'),
            eq(auditLogs.targetId, path),
          ),
        )

      expect(audit).toHaveLength(1)
      expect(audit[0]?.userId).toBeNull()
      expect(audit[0]?.meta).toMatchObject({ via: 'schedule', slug })
    })

    it('leaves a document whose moment has not arrived alone', async () => {
      const slug = `${marker}-future`
      const { path, row } = await scheduledDocument(
        slug,
        new Date(Date.now() + 86_400_000).toISOString(),
      )

      const { result } = await runJob('content.publish-scheduled')

      expect(result.published).not.toContain(path)
      expect((await readDocument(path))?.status).toBe('scheduled')

      // Nothing happened, so nothing is recorded: a revision row or an audit
      // row here would say a publish occurred that did not.
      expect(
        await db
          .select()
          .from(contentRevisions)
          .where(eq(contentRevisions.contentId, row.id)),
      ).toHaveLength(0)
    })
  })
})
