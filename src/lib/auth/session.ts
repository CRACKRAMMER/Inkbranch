import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { env, isProd } from '@/env'
import type { Session, User } from '@/lib/db/schema'
import { hashIp } from './tokens'
import {
  resolveSession,
  touchSession,
  type ResolvedSession,
} from './session-store'

/**
 * Request-scoped session access.
 *
 * This is the only module that touches session cookies. Everything else asks
 * for `getCurrentUser()` or calls a `require*` guard.
 */

export interface RequestContext {
  ip: string | null
  userAgent: string | null
  /** Hashed IP, safe to store. Null when the IP is unknown. */
  ipHash: string | null
  origin: string | null
  referer: string | null
}

/**
 * Extract client details from the current request.
 *
 * `x-forwarded-for` is only trusted when it is present, because a direct
 * connection that sets the header itself would otherwise spoof its own IP and
 * defeat every rate limit. Behind the bundled reverse proxy (the supported
 * deployment) the header is set by the proxy and overwritten on the way in.
 */
export const getRequestContext = cache(async (): Promise<RequestContext> => {
  const headerList = await headers()

  const forwarded = headerList.get('x-forwarded-for')
  const realIp = headerList.get('x-real-ip')
  const rawIp = forwarded?.split(',')[0]?.trim() || realIp?.trim() || null
  const ip = rawIp && rawIp.length <= 45 ? rawIp : null

  return {
    ip,
    userAgent: headerList.get('user-agent'),
    ipHash: ip ? hashIp(ip, env.SESSION_SECRET) : null,
    origin: headerList.get('origin'),
    referer: headerList.get('referer'),
  }
})

/**
 * The signed-in user for this request, or null.
 *
 * Memoised with React `cache`, so a page that checks the session in a layout,
 * a page and three components still performs one database round-trip.
 */
export const getCurrentSession = cache(async (): Promise<ResolvedSession | null> => {
  const cookieStore = await cookies()
  const token = cookieStore.get(env.SESSION_COOKIE_NAME)?.value
  if (!token) return null

  const resolved = await resolveSession(token)
  if (!resolved) return null

  // Best-effort idle refresh; a failure here must not break the request.
  await touchSession(resolved.session).catch(() => undefined)

  return resolved
})

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await getCurrentSession()
  return session?.user ?? null
})

/** True when the request carries a valid session. */
export async function isAuthenticated(): Promise<boolean> {
  return (await getCurrentSession()) !== null
}

/* -------------------------------------------------------------------------- */
/*  Cookie plumbing                                                            */
/* -------------------------------------------------------------------------- */

export interface SessionCookieOptions {
  token: string
  /** Absolute expiry, matching the session row. */
  expiresAt: Date
}

/**
 * Write the session cookie.
 *
 * `SameSite=Lax` rather than `Strict`: the admin is a normal link target, and
 * `Strict` would drop the cookie on the first navigation from an external page,
 * bouncing the user to the login screen. Lax still blocks cross-site POSTs,
 * which is the attack that matters.
 */
export async function setSessionCookie(options: SessionCookieOptions): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set({
    name: env.SESSION_COOKIE_NAME,
    value: options.token,
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires: options.expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set({
    name: env.SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

/**
 * The CSRF token for this session, read from its own cookie.
 *
 * Double-submit: the value is readable by JavaScript (not HttpOnly) so the
 * client can echo it in a header, while the server compares it against the hash
 * stored on the session row. An attacker on another origin can neither read the
 * cookie nor guess the value.
 */
export async function getCsrfToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(csrfCookieName())?.value ?? null
}

export async function setCsrfCookie(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set({
    name: csrfCookieName(),
    value: token,
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    // Session-scoped: it is meaningless without the session cookie anyway.
    expires: undefined,
  })
}

export async function clearCsrfCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set({
    name: csrfCookieName(),
    value: '',
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

function csrfCookieName(): string {
  return `${env.SESSION_COOKIE_NAME}_csrf`
}

/* -------------------------------------------------------------------------- */
/*  Guards                                                                     */
/* -------------------------------------------------------------------------- */

export const LOGIN_PATH = '/admin/login'

/**
 * Require a signed-in session, or redirect to the login page.
 *
 * For the rare page that needs to know *which* session is asking and not only
 * who — the settings page, which marks the row for the device in hand and
 * spares it from the sign-out buttons. Everything else wants `requireUser`.
 */
export async function requireSession(returnTo?: string): Promise<ResolvedSession> {
  const session = await getCurrentSession()
  if (!session) {
    const target = returnTo
      ? `${LOGIN_PATH}?next=${encodeURIComponent(returnTo)}`
      : LOGIN_PATH
    redirect(target)
  }
  return session
}

/**
 * Require a signed-in user, or redirect to the login page.
 *
 * Every admin page and layout calls this. It is the backstop that keeps a new
 * page from shipping unprotected because someone forgot a check.
 */
export async function requireUser(returnTo?: string): Promise<User> {
  return (await requireSession(returnTo)).user
}

/** Require the `owner` role. Editors can write content but not administer. */
export async function requireOwner(returnTo?: string): Promise<User> {
  const user = await requireUser(returnTo)
  if (user.role !== 'owner') {
    redirect('/admin?error=insufficient_role')
  }
  return user
}

export interface ActionContext {
  user: User
  session: Session
  request: RequestContext
}

/**
 * Guard for Server Actions, which cannot `redirect` on success paths cleanly.
 * Throws a typed error the action wrapper converts into a form error instead.
 */
export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(message = 'You are not signed in.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export async function requireActionContext(): Promise<ActionContext> {
  const session = await getCurrentSession()
  if (!session) throw new UnauthorizedError()

  const request = await getRequestContext()
  return { user: session.user, session: session.session, request }
}

/** True when cookies should carry `Secure`. Mirrors the env flag, for docs. */
export function cookiesAreSecure(): boolean {
  return env.COOKIE_SECURE || isProd
}

/**
 * Hostname of the configured site, used when validating the request origin
 * against CSRF. Derived from `SITE_URL` plus the explicit `TRUSTED_ORIGINS`.
 */
export function trustedHosts(): string[] {
  const hosts = new Set<string>(env.TRUSTED_ORIGINS)
  try {
    hosts.add(new URL(env.SITE_URL).host)
  } catch {
    // SITE_URL is validated at boot, so this is unreachable in practice.
  }
  return [...hosts]
}
