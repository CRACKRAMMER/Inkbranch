import 'server-only'
import { jsonLineLogger } from './log'
import type { JobLogger } from './handlers'
import { describeError, runWorker, sleep } from './worker'

/**
 * The job loop, started inside the server process.
 *
 * ## Why the app runs its own worker
 *
 * The deployment this project ships is one container, one database and one
 * author. A second container for a loop that spends almost all of its time
 * asleep would be a second image to build, a second process to watch, and a
 * second thing to explain — and the work it does is not separable from the app
 * in any way that matters: it edits the same Markdown files, writes the same
 * tables and needs the same configuration. So the loop starts with the server.
 *
 * Running several app instances each with a worker is safe, which is what makes
 * this a defensible default rather than a shortcut: the queue claims jobs with
 * `FOR UPDATE SKIP LOCKED` and a lease, so two workers divide the work instead of
 * duplicating it. `WORKER_ENABLED=0` is how an instance opts out.
 *
 * ## Why this is a supervisor and not a call to `runWorker`
 *
 * `runWorker` refuses to start against a database it cannot reach, which is the
 * right behaviour for the CLI: a configuration mistake should stop a process
 * whose only job is the loop, with a message that names it. In the server
 * process that reasoning inverts. The server has another job — serving readers —
 * and it must not be taken down, or held up, by a database that is not ready yet
 * or a migration that has not run.
 *
 * The realistic version of that is the one this exists for: `next start` begins
 * listening before the database is necessarily reachable, and a container that
 * came up alongside Postgres can lose that race every time. So a failed start is
 * retried with a backoff, and the process keeps serving while it waits.
 *
 * Nothing here is awaited by the caller. `stop()` is the only handle, and it is
 * what a graceful shutdown uses — the loop finishes the job in hand within its
 * own grace period and returns.
 *
 * ## What happens at shutdown, and what does not
 *
 * Nothing calls `stop()` on this deployment's behalf. The server that hosts this
 * loop answers `SIGTERM` itself — Next's start-server installs the handler and
 * exits the process as soon as it has closed its listener — so a second handler
 * here would race it and lose, and taking that job over would mean owning the
 * whole shutdown path for the sake of a loop that spends most of its time
 * asleep.
 *
 * So a container stop is abrupt, and the design already covers it. A job in
 * flight is left claimed; the claim expires after `CLAIM_STALE_MS` and another
 * run takes it back. Handlers are written to be safe to run twice — they
 * reconcile from the filesystem rather than applying a delta — and the file
 * writer commits with an atomic rename, so an interrupted job leaves the
 * Markdown either untouched or complete. `stop()` exists for the hosts that can
 * use it: a test, or a future deployment that owns its own signals.
 */

/** First wait after a failed start. Doubles per attempt, up to the ceiling. */
export const START_RETRY_BASE_MS = 30_000
export const START_RETRY_MAX_MS = 15 * 60_000

export interface EmbeddedWorkerOptions {
  /**
   * Where the loop's output goes. One JSON object per line by default, which is
   * also what the CLI writes — a worker is a worker whichever host starts it.
   */
  logger?: JobLogger
  retryBaseMs?: number
  retryMaxMs?: number
  /** Stop the loop when this aborts, instead of calling `stop()`. */
  signal?: AbortSignal
  /**
   * Passed through to `runWorker`.
   *
   * The deployment's knob for these two is `WORKER_INTERVAL_MS`, and an operator
   * should reach for that rather than for code. They exist here for the host
   * that is not a deployment: a test that has to watch a tick happen cannot wait
   * a minute for one.
   */
  intervalMs?: number
  pollMs?: number
}

export interface EmbeddedWorker {
  /** Abort the loop and wait for it to finish. Safe to call more than once. */
  stop(): Promise<void>
  /**
   * The supervisor itself: resolves when the loop has stopped for good, or when
   * the supervisor has been stopped. Never rejects — a failure to start is
   * logged and retried, not thrown into a server that is busy doing something
   * else.
   */
  readonly finished: Promise<void>
}

/** Start the worker loop in the background. Does not wait for it to start. */
export function startEmbeddedWorker(
  options: EmbeddedWorkerOptions = {},
): EmbeddedWorker {
  const log = options.logger ?? jsonLineLogger()
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? START_RETRY_BASE_MS)
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? START_RETRY_MAX_MS)

  const controller = new AbortController()
  const stop = (): void => controller.abort()
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()

  const finished = supervise()

  async function supervise(): Promise<void> {
    let attempt = 0
    let waitMs = retryBaseMs

    while (!controller.signal.aborted) {
      try {
        await runWorker({
          logger: log,
          signal: controller.signal,
          intervalMs: options.intervalMs,
          pollMs: options.pollMs,
          // The pool belongs to request handling. Closing it on the way out of a
          // loop that lives inside the same process would take the app's
          // database connections with it.
          closeDatabaseOnExit: false,
        })
        return
      } catch (error) {
        attempt += 1
        log.error({
          event: 'worker.embedded-start-failed',
          attempt,
          retryInMs: waitMs,
          message: describeError(error),
          name: error instanceof Error ? error.name : 'Error',
        })
      }

      await sleep(waitMs, controller.signal)
      waitMs = Math.min(waitMs * 2, retryMaxMs)
    }
  }

  return {
    finished,
    stop: async () => {
      controller.abort()
      await finished
    },
  }
}
