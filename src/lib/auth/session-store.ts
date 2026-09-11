import { and, eq, lt, ne, or } from 'drizzle-orm'
import { env } from '@/env'
import { db } from '@/lib/db'
import { sessions, users, type Session, type User } from '@/lib/db/schema'
import { generateToken, hashIp, hashToken } from './tokens'

/**
 * Session storage.
 *
 * Deliberately free of `next/headers` so the CLI and tests can create and
 * verify sessions without a request context. The cookie plumbing lives in
 * `session.ts`.
 *
 * Sessions are server-side and stored hashed, which buys three things a signed
 * stateless cookie cannot: immediate revocation, a session list the owner can
 * audit, and no risk of a stolen cookie remaining valid until its expiry.
 */

export interface CreatedSession {
  /** Raw token — write this to the cookie and then forget it. */
  token: string
  /** Raw CSRF token — write this to a readable cookie. */
  csrfToken: string
  session: Session
  expiresAt: Date
}

export async function createSession(
  userId: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = generateToken()
  const csrfToken = generateToken(24)

  const [user] = await db
    .select({ sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    throw new Error(`Cannot create a session for unknown user ${userId}`)
  }

  const now = Date.now()
  const expiresAt = new Date(now + env.SESSION_ABSOLUTE_TTL * 1000)
  const idleExpiresAt = new Date(now + env.SESSION_IDLE_TTL * 1000)

  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      sessionVersion: user.sessionVersion,
      csrfTokenHash: hashToken(csrfToken),
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipHash: context.ip ? hashIp(context.ip, env.SESSION_SECRET) : null,
      expiresAt,
      idleExpiresAt,
    })
    .returning()

  if (!row) throw new Error('Failed to create session')

  return { token, csrfToken, session: row, expiresAt }
}

export interface ResolvedSession {
  session: Session
  user: User
}

/**
 * Look up a session by its raw token.
 *
 * Returns null for expired sessions rather than throwing, and deletes them
 * opportunistically so the table does not need a dedicated cleanup pass to stay
 * bounded.
 */
export async function resolveSession(
  rawToken: string,
): Promise<ResolvedSession | null> {
  if (!rawToken) return null

  const tokenHash = hashToken(rawToken)

  const [result] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)

  if (!result) return null

  const now = new Date()
  const expired =
    result.session.expiresAt <= now || result.session.idleExpiresAt <= now

  if (expired) {
    await db.delete(sessions).where(eq(sessions.id, result.session.id))
    return null
  }

  // A password change bumps `sessionVersion`, invalidating every prior session.
  if (result.session.sessionVersion !== result.user.sessionVersion) {
    await db.delete(sessions).where(eq(sessions.id, result.session.id))
    return null
  }

  return result
}

/**
 * Extend a session's idle window.
 *
 * Writes at most once per `IDLE_TOUCH_INTERVAL_MS`; refreshing on every request
 * would make the sessions table the hottest write target in the system.
 */
const IDLE_TOUCH_INTERVAL_MS = 15 * 60 * 1000

export async function touchSession(session: Session): Promise<void> {
  const now = Date.now()
  const remaining = session.idleExpiresAt.getTime() - now

  // A full idle window still on the clock means it was refreshed moments ago.
  if (remaining > env.SESSION_IDLE_TTL * 1000 - IDLE_TOUCH_INTERVAL_MS) return

  await db
    .update(sessions)
    .set({ idleExpiresAt: new Date(now + env.SESSION_IDLE_TTL * 1000) })
    .where(eq(sessions.id, session.id))
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

export async function destroySessionByToken(rawToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(rawToken)))
}

/** Revoke every session for a user. Called on password change. */
export async function destroyAllUserSessions(userId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id })
  return deleted.length
}

export async function listUserSessions(userId: string): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sessions.createdAt)
}

/** Drop expired rows. Run by the worker so the table stays small. */
export async function pruneExpiredSessions(): Promise<number> {
  const now = new Date()
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.idleExpiresAt, now)))
    .returning({ id: sessions.id })
  return deleted.length
}

/**
 * Sign out everywhere except the current device.
 *
 * Used after a password change when the user chose not to sign themselves out,
 * and from the session list in settings.
 */
export async function destroyOtherSessions(
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id })
  return deleted.length
}
