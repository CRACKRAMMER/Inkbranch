import { analyticsEnabled, recordPageView, type VisitorCookie } from '@/lib/analytics'

/**
 * The page-view beacon.
 *
 * One POST per page from `navigator.sendBeacon`, carrying at most three
 * optional fields. The endpoint is public and unauthenticated by design — the
 * page it is sent from already knows everything in it — and everything that
 * decides whether a view counts (the path, the device class, whether the client
 * is a crawler at all) is derived by `recordPageView` from the request itself
 * rather than taken from the body. That is why this file is short: the rules
 * live in `@/lib/analytics`, and restating any of them here would be a second
 * copy of the one thing on this site that must not drift.
 *
 * ## The address
 *
 * No header carrying an IP address is read here — not `x-forwarded-for`, not
 * `x-real-ip` — and no socket address is consulted. Nothing is passed on to the
 * collector, because the collector does not accept one: there is nothing to
 * redact later and nothing to get wrong in a debug branch.
 *
 * ## Why the status codes are shaped this way
 *
 * A beacon is fire-and-forget: `sendBeacon` ignores the response, so no reader
 * ever sees one. A dropped beacon is therefore answered with 204 rather than an
 * error status — the drop reasons are all expected outcomes (collection turned
 * off, a malformed payload, a referrer that names no page of ours, a crawler),
 * and a client that cannot act on the answer is not made more honest by being
 * told about it.
 *
 * A database failure is the exception and ends in a 500. The reader still never
 * sees it, and `recordPageView` has already logged the cause; the status is the
 * route's own signal, and the only place an operator learns that collection is
 * broken rather than merely quiet. It carries no detail, because the body of a
 * public endpoint's error is not the place for one.
 *
 * ## Why there is no rate limit here
 *
 * A beacon writes a row per request and arrives from anyone, and `RATE_LIMITS`
 * carried an entry for it long before this route existed — `analytics`, "beacons
 * arrive in bursts as a reader scrolls". It is not wired, because a bucket needs
 * a subject and this is the one endpoint in the product with none it may use:
 * the product's other unauthenticated write, the sign-in action, is keyed on the
 * address and on the account, and a beacon has no account to key on and must not
 * read the address.
 *
 * - **The reader's address** is the subject every other limit keys on, and it is
 *   the one thing this route refuses to read — see above, and the same promise
 *   in `@/lib/analytics`.
 * - **The visitor cookie** is the only other stable value, and it is minted by
 *   the client's own response: a client that wants one more beacon sends no
 *   cookie, gets a fresh identity and another full bucket. A limit that any
 *   caller can lift is not a limit, so a policy here would be a promise this
 *   route cannot keep — which is worse than no policy, because the next reader
 *   of `RATE_LIMITS` would count the beacon as covered.
 * - **The site as a whole**, one bucket for everyone, would bound the writes and
 *   drop real readers' views at exactly the traffic this site would most want a
 *   number for. The drop is invisible on purpose — 204 is what every other drop
 *   looks like — so the dashboard would simply be low, and nothing would say so.
 *
 * What bounds the endpoint instead is what a request has to be before it is
 * believed: a same-origin `Referer`, a user agent that is not a crawler, a
 * payload this site's own client would have sent, one indexed lookup and one
 * insert per accepted view, and on the rows themselves
 * `ANALYTICS_RAW_RETENTION_DAYS`. A caller willing to forge all of that is
 * writing rows that a job deletes.
 */

/**
 * `Set-Cookie` for the visitor identifier the collector minted.
 *
 * `HttpOnly` and `SameSite=Lax` are literals in `VisitorCookie` — the type
 * cannot express anything else — so they are written directly instead of being
 * branched on, which would be dead code that reads like a policy someone could
 * flip. `secure` is the field that follows the environment, so it is the one
 * that is conditional.
 */
function setCookieHeader(cookie: VisitorCookie): string {
  const attributes = [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (cookie.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** 204: accepted, and there is nothing for the page to do with the answer. */
function accepted(cookie?: VisitorCookie): Response {
  const headers = new Headers({ 'cache-control': 'no-store' })
  // Only ever set alongside a recorded view: a beacon that was dropped mints no
  // identity, so a crawler or a malformed payload does not get a cookie either.
  if (cookie) headers.append('set-cookie', setCookieHeader(cookie))
  return new Response(null, { status: 204, headers })
}

export async function POST(request: Request): Promise<Response> {
  // Asked before the body is read: on an install that has switched collection
  // off, a beacon is not parsed at all. `recordPageView` asks again — that is
  // the module's own guarantee, and this is only the short circuit.
  if (!analyticsEnabled()) return accepted()

  const outcome = await recordPageView(request)

  if (outcome.recorded) return accepted(outcome.setVisitorCookie)

  if (outcome.reason === 'error') {
    return new Response('The page view could not be recorded. See the server log.\n', {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  return accepted()
}
