import { type NextRequest, NextResponse } from 'next/server'

/**
 * Tell the admin what was requested, so signing in can go back there.
 *
 * ## Why this needs middleware at all
 *
 * The sign-in flow already supports a return destination end to end: the login
 * page reads `?next=`, validates it through `safeNext`, and posts it to the
 * action; `requireUser(returnTo)` builds that URL. The one thing missing was
 * something that could *supply* it — and a server component cannot see the URL
 * it is rendering, only the params its segment was given.
 *
 * The layout is the only place that redirects an unauthenticated visitor, and
 * it has no pathname. Putting the check in each page instead would mean twenty
 * call sites that each have to remember to pass their own path, which is the
 * kind of thing that is right until the twenty-first page is added. Middleware
 * sees every request, so it is the one place that can answer the question once.
 *
 * ## Why a request header and not a response header
 *
 * `NextResponse.next({ request: { headers } })` rewrites the *request* headers
 * the server components read through `headers()`. Setting it on the response
 * would send it to the browser, where nothing needs it.
 *
 * The value is the path and query, never a full URL, and it is read back
 * through `safeNext` — which refuses anything that is not a same-site path — so
 * a crafted `x-pathname` cannot turn the sign-in page into an open redirect.
 * Nothing here is trusted on its own account.
 *
 * ## Scope
 *
 * `/admin` only. Every other route on the site is public, and running
 * middleware over them would add a hop per request to compute a header nobody
 * reads.
 */
export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers)
  headers.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`)

  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: '/admin/:path*',
}
