import process from 'node:process'
import { loadEnvFiles } from './lib/load-env'
import { jsonLineLogger } from '@/lib/jobs/log'

/**
 * Worker entry point (`pnpm worker`).
 *
 * Three jobs and nothing else: load the environment, start the loop, turn
 * signals into a shutdown request.
 *
 * The environment is loaded here, before anything that validates it, which is
 * why the import of `@/lib/jobs` below is dynamic. `src/env.ts` parses
 * `process.env` at module load and refuses to continue without a database URL,
 * and a static import would be evaluated before the first line of this file
 * could run. `@/lib/jobs/log` is imported statically because it imports nothing
 * that reads the environment — the logger has to exist before the worker does.
 *
 * The server starts a worker of its own when `WORKER_ENABLED` is on, which is
 * the default. This entry point is for the two cases where that is not what an
 * operator wants: running the loop in its own process, and running it at all
 * against a deployment whose app instances are not allowed to.
 */

const loadedEnvFiles = loadEnvFiles()

const log = jsonLineLogger()

const { runWorker } = await import('@/lib/jobs')

const shutdown = new AbortController()
let signals = 0

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1

    if (signals === 1) {
      // The worker finishes the job in hand, releases anything it cannot
      // finish, closes the pool and returns.
      log.info({ event: 'worker.signal', signal, action: 'shutdown' })
      shutdown.abort()
      return
    }

    // A second signal is an operator who has run out of patience. The pool may
    // be mid-query, so nothing is closed; exit now and let the claim expire.
    log.error({ event: 'worker.signal', signal, action: 'forcing exit' })
    process.exit(1)
  })
}

// Only reported so that a worker running against the wrong files is obvious on
// sight — the missing ones are not an error, an operator may export everything.
log.info({
  event: 'worker.env',
  files: loadedEnvFiles,
  cwd: process.cwd(),
})

try {
  const summary = await runWorker({
    signal: shutdown.signal,
    logger: log,
    // This process exists only for the worker, so it has to close the pool to
    // exit. The loop the server starts does not: that pool is serving requests.
    closeDatabaseOnExit: true,
  })

  log.info({
    event: 'worker.exit',
    workerId: summary.workerId,
    claimed: summary.claimed,
    completed: summary.completed,
    failed: summary.failed,
    maintenanceRuns: summary.maintenanceRuns,
    ranForMs: summary.stoppedAt.getTime() - summary.startedAt.getTime(),
  })
} catch (error) {
  log.error({
    event: 'worker.failed',
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
  })
  process.exitCode = 1
}
