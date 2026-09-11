import process from 'node:process'
import { loadEnvFiles } from './lib/load-env'
import type { JobLogger, JobLogEvent } from '@/lib/jobs'

/**
 * Worker entry point (`pnpm worker`).
 *
 * Three jobs and nothing else: load the environment, start the loop, turn
 * signals into a shutdown request.
 *
 * The environment is loaded here, before anything that validates it, which is
 * why the imports below are dynamic. `src/env.ts` parses `process.env` at module
 * load and refuses to continue without a database URL, and a static import would
 * be evaluated before the first line of this file could run.
 */

const loadedEnvFiles = loadEnvFiles()

const { runWorker } = await import('@/lib/jobs')

/** One JSON object per line: the worker's output is its interface. */
function write(level: 'info' | 'error', event: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...event,
  })
  if (level === 'error') console.error(line)
  else console.log(line)
}

const logger: JobLogger = {
  info: (event: JobLogEvent) => write('info', event),
  error: (event: JobLogEvent) => write('error', event),
}

const shutdown = new AbortController()
let signals = 0

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1

    if (signals === 1) {
      // The worker finishes the job in hand, releases anything it cannot
      // finish, closes the pool and returns.
      write('info', { event: 'worker.signal', signal, action: 'shutdown' })
      shutdown.abort()
      return
    }

    // A second signal is an operator who has run out of patience. The pool may
    // be mid-query, so nothing is closed; exit now and let the claim expire.
    write('error', { event: 'worker.signal', signal, action: 'forcing exit' })
    process.exit(1)
  })
}

// Only reported so that a worker running against the wrong files is obvious on
// sight — the missing ones are not an error, an operator may export everything.
write('info', {
  event: 'worker.env',
  files: loadedEnvFiles,
  cwd: process.cwd(),
})

try {
  const summary = await runWorker({
    signal: shutdown.signal,
    logger,
    // The CLI owns its process; an embedded worker would not.
    closeDatabaseOnExit: true,
  })

  write('info', {
    event: 'worker.exit',
    workerId: summary.workerId,
    claimed: summary.claimed,
    completed: summary.completed,
    failed: summary.failed,
    maintenanceRuns: summary.maintenanceRuns,
    ranForMs: summary.stoppedAt.getTime() - summary.startedAt.getTime(),
  })
} catch (error) {
  write('error', {
    event: 'worker.failed',
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
  })
  process.exitCode = 1
}
