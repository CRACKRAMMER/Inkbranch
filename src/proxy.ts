import { type NextRequest, NextResponse } from 'next/server'

import { resolveRedirect } from '@/lib/redirects'

/**
 * The two things that have to happen before a route renders.
 *
 * ## Redirects
 *
 * Stored redirects are consulted here because nothing else can answer for a
 * path that no route serves. A redirect has to run before routing — that is the
 * whole point of it — and the not-found boundary is *after* routing, where the
 * response is already a 404 and the only status left to send is another 404.
 * The admin could not do it either: `redirect()` from a server component
 * produces a 307 and cannot express the 301 that makes a permanent move
 * permanent. A moved URL is exactly the case where the status code is the part
 * that matters, because it is what tells a crawler to transfer the ranking.
 *
 * `resolveRedirect` is one indexed lookup, reached only after a few string
 * comparisons that rule out the paths which cannot redirect at all, and it
 * fails open — a database it cannot reach costs a visitor their redirect rather
 * than turning every URL on the site into a 500.
 *
 * The query string is not carried over. `normalizeRedirectPath` treats `/old?a=1`
 * and `/old` as the same row, so the stored rule has no opinion about the query
 * and inventing one has no basis; a reader arriving from a campaign link reaches
 * the destination intact, and that is the part that matters. A redirect on a
 * paginated path that genuinely needs its query is a rule this design cannot
 * express, and saying so is better than guessing.
 *
 * Only `GET` and `HEAD` are redirected. A `POST` to a moved endpoint is a client
 * that has not been updated, and silently rewriting it — with the body intact —
 * is a more interesting failure than the 404 it should get.
 *
 * ## The admin's return path
 *
 * The sign-in flow supports a destination end to end: the login page reads
 * `?next=`, validates it through `safeNext`, and posts it to the action;
 * `requireUser(returnTo)` builds that URL. The one thing missing was something
 * that could *supply* it — a server component cannot see the URL it is
 * rendering, only the params its segment was given.
 *
 * The admin layout is the only place that redirects an unauthenticated visitor,
 * and it has no pathname. Putting the check in each page instead would mean
 * twenty call sites that each have to remember to pass their own path, which is
 * the kind of thing that is right until the twenty-first page is added. The
 * proxy sees every request, so it is the one place that can answer once.
 *
 * It is set on the *request* headers, which is what the server components read
 * through `headers()`. Setting it on the response would send it to the browser,
 * where nothing needs it. The value is a path and query, never a full URL, and
 * it is read back through `safeNext` — which refuses anything that is not a
 * same-site path — so a crafted `x-pathname` cannot turn the sign-in page into
 * an open redirect. Nothing here is trusted on its own account.
 *
 * ## Why one file and not two
 *
 * Only one proxy file is allowed per project, so a feature that needs the
 * request early has no choice but to share the file. Both jobs are cheap, and
 * both are things that can only be done here — which is the test for what
 * belongs: a third thing should be added only if it, too, cannot be done
 * anywhere else.
 */

/** Methods a redirect may answer. */
const REDIRECTABLE_METHODS = new Set(['GET', 'HEAD'])

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const headers = new Headers(request.headers)
    headers.set('x-pathname', `${pathname}${search}`)
    return NextResponse.next({ request: { headers } })
  }

  if (REDIRECTABLE_METHODS.has(request.method)) {
    const hit = await resolveRedirect(pathname)
    if (hit) {
      // A stored target may be an absolute URL, and `new URL` returns it
      // unchanged when it is — which is what makes an external redirect work
      // through the same line as an internal one.
      return NextResponse.redirect(new URL(hit.toPath, request.url), hit.statusCode)
    }
  }

  return NextResponse.next()
}

/**
 * Every path except the ones that could never redirect.
 *
 * `/_next` is the framework's, `/api` is the application's, and `uploads/` is
 * content-addressed files — none of them is a page, and `isResolvableRedirectSource`
 * refuses them at write time anyway. Excluding them here as well means the
 * proxy is not invoked at all for the most common requests a site serves, which
 * is where the saving actually is: a missing chunk or image is the single most
 * frequent request on any site.
 *
 * The final alternative drops anything with a dot in it — favicons, fonts,
 * `robots.txt`, `sitemap.xml`, and whatever a crawler decides to ask for. The
 * cost is that a post whose slug contains a dot does not get redirects, which
 * is a real limitation and a deliberately accepted one: a slug with a dot is
 * rare, and every asset request is not.
 */
export const config = {
  matcher: ['/((?!api/|_next/|uploads/|.*\\..*).*)'],
}
