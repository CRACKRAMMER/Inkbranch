'use server'

import { eq, sql } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { verifyCsrfForPreAuth } from '@/lib/auth/csrf'
import { MAX_PASSWORD_LENGTH, hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password'
import {
  RATE_LIMITS,
  consumeRateLimit,
  resetRateLimit,
  retryAfterSeconds,
} from '@/lib/auth/rate-limit'
import {
  LOGIN_PATH,
  clearCsrfCookie,
  clearSessionCookie,
  getCurrentSession,
  getRequestContext,
  setCsrfCookie,
  setSessionCookie,
} from '@/lib/auth/session'
import { createSession, destroySession } from '@/lib/auth/session-store'
import { hashToken } from '@/lib/auth/tokens'
import { safeNext } from '@/lib/admin/next-path'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

/**
 * Sign-in and sign-out.
 *
 * Sign-in is the one action that runs before a session exists, so it cannot
 * carry a session-bound CSRF token. It gets the origin check instead, plus two
 * independent rate limits — per address and per account — because the two
 * attacks they stop are different: guessing one password many times, and
 * spraying one password across many accounts.
 */

export interface LoginState {
  error?: string
  detail?: string
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  next: z.string().max(512).optional(),
})

/** Rate-limit keys carry a hash rather than the address itself. */
function accountKey(email: string): string {
  return `login:user:${hashToken(email).slice(0, 32)}`
}

export async function loginAction(
  _previous: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  try {
    await verifyCsrfForPreAuth()
  } catch {
    // Origin failures have exactly one sensible remedy, and it is not "call
    // support": the page is stale or the request did not come from this site.
    return {
      error: 'This sign-in request could not be verified.',
      detail: 'Reload the page and try again.',
    }
  }

  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  })

  if (!parsed.success) {
    return { error: 'Enter an email address and password.' }
  }

  const { email, password } = parsed.data
  const next = safeNext(parsed.data.next)
  const request = await getRequestContext()

  const ipKey = `login:ip:${request.ipHash ?? 'unknown'}`

  const ipLimit = await consumeRateLimit(ipKey, RATE_LIMITS.login)
  if (!ipLimit.allowed) {
    await recordAudit({
      action: 'auth.login_failed',
      outcome: 'denied',
      metadata: { reason: 'rate_limited', subject: 'ip' },
      request,
    })
    return {
      error: 'Too many sign-in attempts from this address.',
      detail: `Try again in ${Math.ceil(retryAfterSeconds(ipLimit) / 60)} minute(s).`,
    }
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!user) {
    await recordAudit({
      action: 'auth.login_failed',
      outcome: 'denied',
      metadata: { reason: 'unknown_account' },
      request,
    })
    // Deliberately the same message as a wrong password: which half was wrong is
    // information an attacker would otherwise get for free.
    return { error: 'Email or password is incorrect.' }
  }

  const accountLimit = await consumeRateLimit(accountKey(email), RATE_LIMITS.loginAccount)
  if (!accountLimit.allowed) {
    await recordAudit({
      action: 'auth.login_failed',
      actorId: user.id,
      outcome: 'denied',
      metadata: { reason: 'rate_limited', subject: 'account' },
      request,
    })
    return {
      error: 'Too many sign-in attempts for this account.',
      detail: `Try again in ${Math.ceil(retryAfterSeconds(accountLimit) / 60)} minute(s).`,
    }
  }

  const valid = await verifyPassword(user.passwordHash, password)
  if (!valid) {
    await recordAudit({
      action: 'auth.login_failed',
      actorId: user.id,
      outcome: 'denied',
      metadata: { reason: 'bad_password' },
      request,
    })
    return { error: 'Email or password is incorrect.' }
  }

  // The hash parameters live with the hash, and a successful sign-in is the only
  // moment the plaintext is available to upgrade them.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password)
    await db
      .update(users)
      .set({ passwordHash: upgraded, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
  }

  const { token, csrfToken, expiresAt } = await createSession(user.id, {
    ip: request.ip,
    userAgent: request.userAgent,
  })

  await setSessionCookie({ token, expiresAt })
  await setCsrfCookie(csrfToken)
  await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id))
  await resetRateLimit(ipKey)

  await recordAudit({
    action: 'auth.login',
    actorId: user.id,
    targetType: 'user',
    targetId: user.id,
    request,
  })

  redirect(next)
}

/**
 * Sign out.
 *
 * The CSRF token is deliberately not required: this action destroys nothing an
 * attacker gains from, and refusing to sign someone out because their tab went
 * stale would be a worse failure than the one it prevents.
 */
export async function logoutAction(): Promise<never> {
  const request = await getRequestContext()
  const current = await getCurrentSession()

  if (current) {
    await recordAudit({
      action: 'auth.logout',
      actorId: current.user.id,
      targetType: 'user',
      targetId: current.user.id,
      request,
    })
    // By session id, not by cookie value: the row is what authenticates, and it
    // must be gone even if the response never reaches the browser.
    await destroySession(current.session.id)
  }

  await clearSessionCookie()
  await clearCsrfCookie()
  redirect(LOGIN_PATH)
}
