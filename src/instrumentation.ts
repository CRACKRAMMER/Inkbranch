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
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertProductionPosture } = await import('@/env')
  assertProductionPosture()
}
