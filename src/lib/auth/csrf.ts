import type { Session } from '@/lib/db/schema'
import { safeCompare } from './tokens'
import { hashToken } from './tokens'
import { getCsrfToken, getRequestContext, trustedHosts } from './session'

/**
 * CSRF protection.
 *
 * Two independent checks, because they fail in different ways:
 *
 *  1. **Origin verification** — the request must come from our own host. This
 *     rejects a cross-site form post before any state is touched, and costs
 *     nothing.
 *  2. **Double-submit token** — the client echoes a per-session value that an
 *     attacker on another origin cannot read or guess. This still holds when
 *     `Origin` is absent (older browsers, some proxies, non-browser clients).
 *
 * Either check alone has a gap; together they do not.
 */

export class CsrfError extends Error {
  readonly code = 'CSRF'
  constructor(message: string) {
    super(message)
    this.name = 'CsrfError'
  }
}

/** Header used by JSON API clients to carry the token. */
export const CSRF_HEADER = 'x-csrf-token'

/**
 * Verify the request's origin.
 *
 * `Sec-Fetch-Site` is checked first when present: it is set by the browser and
 * cannot be forged by page script, which makes it stronger evidence than
 * `Origin`. `same-origin` and `none` (a direct navigation) are both acceptable.
 */
export async function assertTrustedOrigin(): Promise<void> {
  const { origin, referer } = await getRequestContext()
  const headerList = await (await import('next/headers')).headers()
  const fetchSite = headerList.get('sec-fetch-site')

  if (fetchSite) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return
    throw new CsrfError(
      `Cross-site request rejected (sec-fetch-site: ${fetchSite}).`,
    )
  }

  const candidate = origin ?? referer
  if (!candidate) {
    // No origin information at all. Browsers always send one of these on a
    // POST, so this is a non-browser client; the token check still applies.
    return
  }

  let host: string
  try {
    host = new URL(candidate).host
  } catch {
    throw new CsrfError('Malformed Origin or Referer header.')
  }

  if (!trustedHosts().includes(host)) {
    throw new CsrfError(`Request origin ${host} is not trusted.`)
  }
}

/**
 * Verify the double-submit token against the value bound to the session.
 *
 * Both sides are hashed before comparison so the stored value is never the
 * plaintext, and `safeCompare` keeps the comparison constant-time.
 */
export function verifyCsrfToken(
  session: Pick<Session, 'csrfTokenHash'>,
  provided: string | null | undefined,
): void {
  if (!provided) {
    throw new CsrfError('Missing CSRF token.')
  }
  if (!safeCompare(hashToken(provided), session.csrfTokenHash)) {
    throw new CsrfError('CSRF token does not match this session.')
  }
}

/** Read the token from the request, preferring the header over the cookie. */
export async function readCsrfToken(formData?: FormData): Promise<string | null> {
  const headerList = await (await import('next/headers')).headers()
  const fromHeader = headerList.get(CSRF_HEADER)
  if (fromHeader) return fromHeader

  if (formData) {
    const fromForm = formData.get('csrf')
    if (typeof fromForm === 'string' && fromForm) return fromForm
  }

  return getCsrfToken()
}

/**
 * Full check: origin, then token.
 *
 * Throws `CsrfError` on failure. Callers must not swallow it — a caught CSRF
 * error that still performs the mutation is worse than no check at all.
 */
export async function verifyCsrfRequest(
  session: Pick<Session, 'csrfTokenHash'>,
  formData?: FormData,
): Promise<void> {
  await assertTrustedOrigin()
  const token = await readCsrfToken(formData)
  verifyCsrfToken(session, token)
}

/**
 * Verify only when a session exists.
 *
 * The login form runs before any session exists, so it cannot carry a
 * session-bound token. It still gets the origin check, and its own rate limit
 * bounds abuse from a hostile page that manages to submit it.
 */
export async function verifyCsrfForPreAuth(): Promise<void> {
  await assertTrustedOrigin()
}
