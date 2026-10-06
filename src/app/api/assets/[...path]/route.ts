import { open } from 'node:fs/promises'
import { constants } from 'node:fs'

import { UPLOAD_ROOT, resolveAssetFile } from '@/lib/assets/storage'
import { assertNoSymlinkPath, PathSecurityError } from '@/lib/security/paths'
import { sniffMime } from '@/lib/security/mime'

/**
 * Uploaded assets, served from the upload root.
 *
 * ## Why this route exists at all
 *
 * Both `/api/assets/**` and the default `/uploads/**` URL are served here.
 * `next.config.ts` rewrites the latter before static-file lookup, so even a
 * directory under `public/` cannot bypass private-path and symlink checks or
 * the SVG sandbox. A custom storage root gets the same serving policy.
 *
 * ## The three rules
 *
 * 1. **Only files under `UPLOAD_ROOT`.** The path comes from the request, so it
 *    goes through `resolveAssetFile`, which refuses `..`, absolute segments and
 *    anything that resolves outside the root. Nothing here reads a URL into
 *    `fs` directly.
 * 2. **The type is sniffed, never taken.** The extension and the request's
 *    `Accept` are both attacker-controlled, so the content type is derived from
 *    the bytes. A file whose bytes are not a format this site serves is sent as
 *    an attachment with a generic type — never inline, and never as anything a
 *    browser would parse as a document.
 * 3. **`text/html` is never a possible answer.** The type comes from the sniff
 *    table plus `application/octet-stream`; there is no branch that could
 *    produce HTML, and the CSP below makes a file that somehow contains script
 *    inert even if one were served inline.
 *
 * ## Why `next.config.ts` excludes this path
 *
 * A config header is applied to the response *after* the route has run, so a
 * `/:path*` rule replaces whatever the route set for the same key. This route
 * sends `default-src 'none'; sandbox`; the site-wide rule sends
 * `default-src 'self'`, which would permit a served SVG to load same-origin
 * resources if a browser ever navigated to one directly. The config therefore
 * excludes both upload URL prefixes with a negative lookahead, so the
 * policy below is the one this path is actually served with.
 *
 * That leaves two independent mitigations rather than one: the sniffer, which
 * refuses to label anything it does not recognise, and the sandbox, which
 * denies the document a script context even if a type were wrong.
 */

/**
 * `sandbox` with no value is the strictest form: a unique opaque origin, no
 * scripts, no forms, no navigation, and every fetch directive already denied by
 * `default-src 'none'`. This is what makes the SVG sanitiser's blocklist
 * acceptable — it is a second line of defence, not the only one.
 */
const CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox"

/**
 * Content-addressed paths never change: the filename is the hash of the bytes,
 * so a corrected file is a different URL. That is what makes a year safe to ask
 * for, and `immutable` is what stops a browser from revalidating an image it
 * already has.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * The two headers every response from this route carries, including the errors:
 * the sandbox CSP because a served SVG is the one asset that can execute, and
 * `nosniff` because the type is a decision made here.
 *
 * `Cache-Control` is *not* in this set. A miss is not immutable — an asset whose
 * URL has not been written yet will exist later, and a 404 cached for a year
 * would shadow it — so errors are `no-store` and only a real file gets the year.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * Derived from the request path, so it is not trusted: quotes, backslashes and
 * control characters are removed rather than escaped, because a header value
 * with a newline in it is a response-splitting bug and there is no filename an
 * uploaded asset needs that this would keep.
 */
function attachmentName(segments: readonly string[]): string {
  const last = segments[segments.length - 1] ?? 'asset'
  const safe = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return safe || 'asset'
}

function textResponse(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      ...BASE_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** A missing file and a file that is not there to be read are the same answer. */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR'
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await context.params

  if (!segments || segments.length === 0 || segments.some((part) => !part)) {
    return textResponse('No asset path was given.', 404)
  }

  let absolute: string
  try {
    // `%2e%2e%2f` is decoded by the router, so a segment can arrive containing
    // a separator or a parent reference; the containment check is on the joined
    // path, which is why it is this function and not a segment check here.
    absolute = resolveAssetFile(segments.join('/'))
    if (segments.join('/').replace(/\\/g, '/').split('/').some((part) => part.startsWith('.'))) {
      return textResponse('No such asset.', 404)
    }
    await assertNoSymlinkPath(UPLOAD_ROOT, absolute, 'asset')
  } catch (error) {
    if (error instanceof PathSecurityError) {
      return textResponse('That path is not a valid asset path.', 400)
    }
    // Not a rejection but a failure — a broken root, a path that cannot be
    // resolved at all. Reported rather than rethrown so the answer is a small
    // text response instead of the framework's HTML error page.
    console.error(
      '[assets] the asset path could not be resolved:',
      error instanceof Error ? error.message : error,
    )
    return textResponse('The asset path could not be resolved. See the server log.', 500)
  }

  try {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    const sniffed = sniffMime(bytes)

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'cache-control': CACHE_CONTROL,
    }
    if (sniffed.allowed) {
      headers['content-type'] = sniffed.mime
    } else {
      // Not a format this site accepts, so it is handed over rather than shown.
      headers['content-type'] = 'application/octet-stream'
      headers['content-disposition'] =
        `attachment; filename="${attachmentName(segments)}"`
    }

    return new Response(new Uint8Array(bytes), { status: 200, headers })
  } catch (error) {
    if (isMissing(error)) {
      return textResponse('No such asset.', 404)
    }
    // A permission error, a full disk, a path that is a directory: the file may
    // well be there, and saying "not found" would send the operator looking in
    // the wrong place.
    console.error(
      '[assets] the asset could not be read:',
      error instanceof Error ? error.message : error,
    )
    return textResponse('The asset could not be read. See the server log.', 500)
  }
}
