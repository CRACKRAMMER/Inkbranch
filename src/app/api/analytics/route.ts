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
