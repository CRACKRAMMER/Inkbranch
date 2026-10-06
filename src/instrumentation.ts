/**
 * Server startup.
 *
 * `register()` runs once per server process, before the first request is
 * handled, and — the reason this file exists — *not* during `next build`.
 * That makes it the only place where a check can distinguish "this code is
 * being imported so a route's page data can be collected" from "this code is
 * about to serve someone".
 *
 * The environment's shape is validated at import in `src/env.ts`, because a
 * missing database URL is a bug wherever it happens. Its production *posture*
 * is validated here, because the variables a build runs with are not the ones a
 * deployment is given: `next build` forces `NODE_ENV=production`, so checking
 * the secret and cookie settings at import time made the build fail on any
 * machine that had not already been configured like a live server.
 *
 * The risk of the split is that the checks are skipped if `register` never
 * runs. It always runs — Next calls it on every server start, including the
 * standalone server the container image boots. Next can catch a rejected hook
 * while leaving the listener open, so production configuration failures below
 * explicitly exit with code 1. A supervisor can then report and restart the
 * failed process instead of retaining a server that never became ready.
 *
 * `NEXT_RUNTIME` is read rather than assumed: `register` is also invoked for
 * the edge runtime, where none of these variables are read and where throwing
 * would break a deployment that is otherwise fine.
 *
 * ## Why the job worker starts here too
 *
 * This is the only hook a Next.js server has for "this process is now going to
 * serve people", which is exactly the condition the worker's loop needs: it has
 * to run in a process that is long-lived, that has the same filesystem and the
 * same database as the request handlers, and that is not a build. An earlier
 * version of this file only checked the environment, and the consequence was a
 * worker that existed, was tested, and was started by nothing at all — scheduled
 * posts published by the read path, and analytics never rolled up.
 *
 * The start is deliberately not awaited and deliberately cannot throw: see
 * `@/lib/jobs/embedded` for why a database that is not ready yet must not take
 * the server down with it. `WORKER_ENABLED=0` skips it, for an instance that
 * should serve requests and nothing else.
 *
 * ## Why the syntax highlighter is warmed here, and not awaited
 *
 * Shiki's grammars and themes are built on first use, and so are the scanners
 * that turn each grammar's patterns into JavaScript regular expressions. That
 * work lands on whichever request renders the first fenced code block after a
 * restart: measured at 330 ms for that render against 34 ms for the same page
 * immediately afterwards. Moving it here means the first reader is not the one
 * who pays.
 *
 * It is started, not awaited, and it is not a close call. The warm-up runs for
 * seconds rather than milliseconds, it deliberately yields to the event loop
 * throughout (`warmHighlighter` says why), and nothing about serving a request
 * depends on it. Awaiting it would delay the job worker below for a reason
 * that has nothing to do with jobs — and would not make the first request any
 * faster, because a request that arrives after startup is a request that
 * arrives after startup.
 *
 * `warmHighlighter` catches its own errors and logs them: a grammar that will
 * not load degrades one code block to plain text, and that must not be a reason
 * to refuse to serve. Nothing it does can reject.
 *
 * The other half of the story is that this file's module registry is not the
 * route handlers'. Warming a cache that lives in module scope here would fill a
 * variable no render ever reads, which is exactly what a first attempt at this
 * did. `@/lib/markdown/shiki` keeps its caches on `globalThis` for that reason,
 * and says there how it was measured.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  let startupEnv: typeof import('@/env')['env']
  try {
    const { assertProductionPosture, env } = await import('@/env')
    assertProductionPosture()
    startupEnv = env
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') throw error
    // Validation messages name fields and accepted shapes, never their values.
    console.error('[startup] Configuration refused:', error instanceof Error
      ? error.message : 'Unable to validate server configuration')
    process.exit(1)
  }

  const { warmHighlighter } = await import('@/lib/markdown/shiki')
  void warmHighlighter()

  if (!startupEnv.WORKER_ENABLED) return

  const { startEmbeddedWorker } = await import('@/lib/jobs')
  startEmbeddedWorker()
}
