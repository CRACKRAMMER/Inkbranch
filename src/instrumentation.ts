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
 * standalone server the container image boots — and the failure is fatal, so a
 * configuration that should have been refused takes down the process rather
 * than being served from.
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
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertProductionPosture, env } = await import('@/env')
  assertProductionPosture()

  if (!env.WORKER_ENABLED) return

  const { startEmbeddedWorker } = await import('@/lib/jobs')
  startEmbeddedWorker()
}
