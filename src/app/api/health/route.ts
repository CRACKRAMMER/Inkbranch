import { checkContentDrift } from '@/lib/content/sync'
import { pingDatabase } from '@/lib/db'

/**
 * Health, for the Docker healthcheck and for whoever is on call.
 *
 * Two questions, and only two: is the database answering, and does the content
 * index still match the Markdown on disk. Those are the two ways this site can
 * be running and wrong — a process that is up, serving pages, and reporting a
 * document that no longer exists.
 *
 * ## What is deliberately not here
 *
 * No environment dump, no version string, no connection details, no filesystem
 * paths, and no error text from the database. The endpoint is public because a
 * healthcheck cannot hold a session, so everything it says is said to anyone
 * who asks: booleans and counts are what a monitor needs, and a failing
 * dependency is named by its role rather than by whatever its driver said. The
 * driver's own message — which can name a host, a user or a socket — is logged
 * server-side instead, where only the operator reads it.
 *
 * ## Why drift is not a 503
 *
 * A database that is not answering means the site cannot serve, and that is a
 * 503. Content drift does not: the pages still render, and the thing that fixes
 * the drift is the sync job, not a restart. Reporting it as 503 would put a
 * container that is working perfectly well into a restart loop that cannot
 * possibly help, so drift is reported in the body as `degraded` with the counts
 * that show what happened, and the status code stays 200.
 */

/**
 * A degree of detail worth publishing: enough for a monitor to alert on, and
 * nothing that describes the deployment.
 */
type DatabaseHealth =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: 'unreachable' }

type ContentIndexHealth =
  | { ok: true; drift: boolean; scanned: number; indexed: number }
  | { ok: false; reason: 'unavailable' }

interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable'
  database: DatabaseHealth
  contentIndex: ContentIndexHealth
}

/**
 * Rendered per request, and never cached: a cached health check answers for the
 * past, which is the one answer it must not give.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const ping = await pingDatabase()

  // The driver's message never leaves the server. `pingDatabase` reports it
  // rather than throwing, so this is the one place the cause is visible at all —
  // an unreported outage would be an endpoint saying "unreachable" with no way
  // to find out why.
  let database: DatabaseHealth
  if (ping.ok) {
    database = { ok: true, latencyMs: ping.latencyMs }
  } else {
    console.error('[health] database check failed:', ping.error)
    database = { ok: false, reason: 'unreachable' }
  }

  let contentIndex: ContentIndexHealth
  try {
    const drift = await checkContentDrift()
    contentIndex = {
      ok: true,
      drift: drift.drift,
      scanned: drift.scanned,
      indexed: drift.indexed,
    }
  } catch (error) {
    // Both halves of the check read the index and the content tree, so this is
    // the same failure the check above reports — reported, not thrown, because
    // half an answer is still worth serving.
    console.error(
      '[health] content index check failed:',
      error instanceof Error ? error.message : error,
    )
    contentIndex = { ok: false, reason: 'unavailable' }
  }

  const status: HealthReport['status'] = !database.ok
    ? 'unavailable'
    : !contentIndex.ok || contentIndex.drift
      ? 'degraded'
      : 'ok'

  const report: HealthReport = { status, database, contentIndex }

  return Response.json(report, {
    status: status === 'unavailable' ? 503 : 200,
    headers: { 'cache-control': 'no-store' },
  })
}
