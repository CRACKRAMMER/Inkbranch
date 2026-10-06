import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { scheduledJobs } from '@/lib/db/schema'
import {
  CADENCE_KINDS,
  startEmbeddedWorker,
  type JobLogger,
  type JobLogEvent,
} from '@/lib/jobs'
import { hasTestDatabase } from '../setup'

/**
 * The worker the server starts for itself.
 *
 * The queue is tested in `tests/unit/jobs.test.ts` and the handlers are tested
 * beside it; what neither of those covers is the thing that makes either of
 * them matter in a deployment — a loop that nobody starts. For a while that was
 * literally the case here: the worker existed, was tested, and was started by
 * nothing at all, so scheduled posts were published by whoever happened to load
 * a page and analytics were never rolled up.
 *
 * So this starts the real thing against the real database and watches it do the
 * two things that are easy to get wrong and impossible to notice: enqueue its
 * own cadence, and stop when it is told to.
 *
 * ## What this test runs, and what that costs
 *
 * The loop claims and runs what it enqueues, against whatever `CONTENT_DIR` this
 * suite has — an empty temporary directory. `content.sync` reconciles the index
 * against that directory, so it deletes the index rows of files that do not
 * exist, including rows another test file created before this one ran. That is
 * the job working correctly, and it is why the assertions about the content
 * index live in the files that create it: vitest runs these files one at a time,
 * so no file is waiting on a row this one removes.
 *
 * The alternative — a flag that stopped the loop from running anything — would
 * be a test of a worker that is not the one that ships.
 */

/** How long to wait for the loop to do something. Generous; it is asynchronous. */
const WAIT_TIMEOUT_MS = 15_000

describe.runIf(hasTestDatabase)('the embedded worker', () => {
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
  /**
   * Remove the cadence's own bookkeeping before and after.
   *
   * A pending row under the `cadence` dedupe key makes the next enqueue for that
   * kind a no-op, so a leftover from an interrupted run would leave this test
   * waiting for a row that can never appear.
   */
  const clearCadenceRows = () =>
    db.delete(scheduledJobs).where(eq(scheduledJobs.dedupeKey, 'cadence'))

  afterAll(clearCadenceRows)

  interface RecordedLog {
    events: JobLogEvent[]
    logger: JobLogger
  }

  function recordingLogger(): RecordedLog {
    const events: JobLogEvent[] = []
    return {
      events,
      logger: {
        info: (event) => events.push(event),
        error: (event) => events.push(event),
      },
    }
  }

  async function cadenceRows() {
    return db
      .select()
      .from(scheduledJobs)
      .where(
        inArray(
          scheduledJobs.type,
          CADENCE_KINDS.map((kind) => kind as string),
        ),
      )
      .orderBy(desc(scheduledJobs.createdAt))
  }

  /** Poll until `check` returns something, or fail saying what never happened. */
  async function waitFor<T>(
    description: string,
    check: () => Promise<T | null>,
  ): Promise<T> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    for (;;) {
      const value = await check()
      if (value !== null) return value

      if (Date.now() > deadline) {
        throw new Error(
          `Waited ${WAIT_TIMEOUT_MS}ms for ${description}. The worker writes a job row for every kind it enqueues and another when one finishes; neither appeared.`,
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('enqueues its cadence, drains it, and stops when told to', async () => {
    await clearCadenceRows()

    const { events, logger } = recordingLogger()
    const worker = startEmbeddedWorker({
      logger,
      // A tick every 200ms instead of every minute, and a poll that keeps the
      // loop responsive between ticks. Both are the deployment's settings, only
      // faster: `WORKER_INTERVAL_MS` is what an operator would change.
      intervalMs: 200,
      pollMs: 50,
      retryBaseMs: 100,
    })

    try {
      // Every kind, enqueued by the loop's first sweep of the cadence table.
      const enqueued = await waitFor('the cadence to be enqueued', async () => {
        const rows = await cadenceRows()
        const kinds = new Set(rows.map((row) => row.type))
        return CADENCE_KINDS.every((kind) => kinds.has(kind)) ? rows : null
      })

      // And then run: a row that reaches a terminal status is a job the loop
      // claimed, handed to its handler and recorded.
      await waitFor('a cadence job to finish', async () => {
        const rows = await cadenceRows()
        return rows.some((row) => row.status === 'done' || row.status === 'failed')
      })

      const before = new Set((await cadenceRows()).map((row) => row.id))

      await worker.stop()

      // Every kind was drained before the stop, so a loop still running would
      // enqueue all of them again within one interval. Nothing may appear.
      await new Promise((resolve) => setTimeout(resolve, 600))
      const after = await cadenceRows()
      const strays = after.filter((row) => !before.has(row.id))

      expect(strays.map((row) => row.type)).toEqual([])

      // The loop reports its own stop, which is the difference between a
      // shutdown and a process that happened to exit.
      const stopped = events.filter((event) => event.event === 'worker.stop')
      expect(stopped).toHaveLength(1)

      // It ran the cadence it enqueued, and it did not fail at it. A kind that
      // cannot run reports `job-failed`; the two `analytics` kinds and the
      // orphan scan are the ones this test would notice first, since they are
      // the ones nothing else triggers.
      expect(events.some((event) => event.event === 'worker.start')).toBe(true)
      expect(events.some((event) => event.event === 'worker.cadence')).toBe(true)
      expect(
        events.some((event) => event.event === 'worker.job-failed'),
        JSON.stringify(events.filter((event) => event.event === 'worker.job-failed')),
      ).toBe(false)

      expect(enqueued.length).toBeGreaterThanOrEqual(CADENCE_KINDS.length)
    } finally {
      await worker.stop()
      await clearCadenceRows()
    }
  })

  it('runs one maintenance pass per interval, and prunes its own history', async () => {
    // The retention sweep and the cadence share a tick. `JOB_RETENTION_DAYS`
    // defaults to a week, so nothing this test creates is old enough to delete
    // — what is being checked is that the pass happens and does not disturb the
    // queue it is trimming.
    await clearCadenceRows()

    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const [finished] = await db
      .insert(scheduledJobs)
      .values({
        type: 'content.sync',
        status: 'done',
        payload: { marker: 'worker-test-prune' },
        attempts: 1,
        createdAt: old,
        finishedAt: old,
      })
      .returning()

    const [pending] = await db
      .insert(scheduledJobs)
      .values({
        type: 'content.sync',
        status: 'pending',
        payload: { marker: 'worker-test-prune' },
        // Far enough in the future that the loop will not claim it while this
        // test runs: a job it did not enqueue is not this test's business.
        runAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning()

    const { logger } = recordingLogger()
    const worker = startEmbeddedWorker({
      logger,
      intervalMs: 150,
      pollMs: 50,
      retryBaseMs: 100,
    })

    try {
      await waitFor('the history prune to run', async () => {
        const rows = await db
          .select({ id: scheduledJobs.id })
          .from(scheduledJobs)
          .where(eq(scheduledJobs.id, finished!.id))
        return rows.length === 0 ? true : null
      })

      // The prune is bounded and status-scoped: work that has not run yet is
      // not history.
      const [survivor] = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, pending!.id))
      expect(survivor?.status).toBe('pending')
    } finally {
      await worker.stop()
      await db
        .delete(scheduledJobs)
        .where(sql`${scheduledJobs.payload}->>'marker' = 'worker-test-prune'`)
      await clearCadenceRows()
    }
  })
})
