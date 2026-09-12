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

/**
 * One session, as the settings page is allowed to see it.
 *
 * A projection rather than `Session`, and the two fields left out are the
 * reason: `tokenHash` and `csrfTokenHash` are what makes a row authenticate, and
 * a type that cannot carry them cannot leak them into a rendered document or a
 * serialized client prop by accident. Everything the list shows is here and
 * nothing else is.
 */
export interface SessionSummary {
  id: string
  userAgent: string | null
  /** Hashed, never raw — see the `ip_hash` column. */
  ipHash: string | null
  createdAt: Date
  /** The absolute end, whatever the device does. */
  expiresAt: Date
  /**
   * When this device was last seen.
   *
   * Derived rather than stored: `touchSession` writes `idle_expires_at` as
   * "now plus the idle window", so subtracting the window back off gives the
   * moment of the write. Accurate to within `IDLE_TOUCH_INTERVAL_MS`, since
   * that is how rarely the write happens — a session used a minute ago and a
   * session used twenty minutes ago can both read as the same instant, and the
   * label is read as "recently", which is what it is for.
   *
   * A session that has never been touched derives to its `createdAt`, because
   * that is when its idle window was written.
   */
  lastSeenAt: Date
}

/**
 * The sessions belonging to one user, oldest first.
 *
 * Read by the settings page. It is the only caller, which is the point of the
 * `ip_hash` column: the address itself is never stored, so a session list is the
 * only thing the hash can ever be shown in.
 *
 * Ordered by creation rather than by activity, so the list does not reshuffle
 * under the cursor of someone about to sign a row out — and tie-broken by id,
 * because two sessions created in the same millisecond are otherwise in
 * whatever order the planner returns.
 */
export async function listUserSessions(userId: string): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ipHash: sessions.ipHash,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      idleExpiresAt: sessions.idleExpiresAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sessions.createdAt, sessions.id)

  return rows.map(({ idleExpiresAt, ...row }) => ({
    ...row,
    lastSeenAt: new Date(idleExpiresAt.getTime() - env.SESSION_IDLE_TTL * 1000),
  }))
}

/**
 * Sign one session out, if it is this user's.
 *
 * ## Why the user id is part of the delete rather than a check before it
 *
 * The session id arrives from the browser, so it is attacker-controlled input:
 * a request can name any row in the table, including one belonging to somebody
 * else. Scoping the delete by `user_id` makes the ownership check and the
 * delete the same statement, so there is no window between deciding and doing —
 * and no way to write the query without the check, which a separate
 * `if (row.userId !== userId)` guard permits the next editor to drop.
 *
 * `false` covers both "that session is not this user's" and "that session is
 * already gone", deliberately. Telling them apart would answer a question the
 * caller has no business asking — the existence of a session id it does not own
 * — for no gain, since both mean the same thing to the person pressing the
 * button: there is nothing left to sign out.
 *
 * The session making the request is not special-cased. The list does not offer
 * to sign out the device you are reading it on, but a caller that names it
 * anyway gets a sign-out the owner can already perform from the header, so
 * refusing would be a rule with nothing behind it.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
    .returning({ id: sessions.id })

  return deleted.length > 0
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
 * Sign out everywhere except one session.
 *
 * Called from the session list in settings. The session it keeps is the one
 * that asked, because the alternative signs the owner out of the page they are
 * standing on.
 *
 * ## Why the password change does not call this
 *
 * It used to say that it did. It does not, and it must not: that operation
 * re-stamps the asking session inside a transaction that also bumps
 * `users.session_version`, and a delete that ran outside it would be a second
 * answer to a question only the version comparison can answer correctly. The
 * two are described against each other in `lib/auth/account.ts`.
 *
 * ## Why this does not bump the version either
 *
 * They are different claims. A password change says "the credential these
 * sessions were created with is retired", so a sign-in that read the version
 * before the change committed and inserted its row after the delete ran must
 * die too, and only the comparison reaches it. This says "sign out the devices
 * signed in now". A row the sweep misses is one being inserted as it runs —
 * `created_at` inside the click, which is a device that has just signed in
 * rather than a survivor of an old credential — and the owner can sweep again.
 *
 * Bumping the version here would also require re-stamping the asking session,
 * which is the whole password-change dance performed for a revocation that is
 * not about a credential.
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
