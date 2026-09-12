import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'

import { hasTestDatabase } from '../setup'

import { hashPassword } from '@/lib/auth/password'
import {
  destroyOtherSessions,
  listUserSessions,
  revokeSession,
} from '@/lib/auth/session-store'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { sessions, users } from '@/lib/db/schema'

/**
 * The session list, and the two ways it signs a device out.
 *
 * ## Why this file exists
 *
 * Three things in the codebase described a screen that did not exist:
 * `sessions.ip_hash` was written on every sign-in and read by nothing,
 * `destroyOtherSessions` named the session list in settings as its caller, and
 * the sessions table's own doc listed "a session list the owner can audit" as
 * one of the reasons to keep sessions in a table. The functions behind it were
 * exported and uncalled, which is a state a test cannot see: an unused export
 * that typechecks is indistinguishable from one that works.
 *
 * The assertions below are therefore about the two claims the screen makes to
 * the person using it. The first is that a row says which device it is and when
 * it was last seen — which is `listUserSessions`, and specifically that its
 * projection cannot carry a token. The second is that signing a row out ends
 * exactly that row — including the case where the id in the request belongs to
 * somebody else, which is the one input to this feature that an attacker
 * chooses.
 */

const PASSWORD = 'a-password-for-the-session-list'

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('the session list', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  /** Every user this file created, so cleanup can remove exactly those. */
  const created: string[] = []

  /**
   * A user of this file's own.
   *
   * The suite shares one database with every other integration file and with
   * the E2E run, which signs in as the seeded owner — and a test that signed
   * *that* user's sessions out would take the end-to-end suite with it. Every
   * assertion here is on rows belonging to a user this file made.
   */
  async function makeUser() {
    const [row] = await db
      .insert(users)
      .values({
        email: `sessions-${randomUUID()}@test.invalid`,
        name: 'Session List Test',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning()

    if (!row) throw new Error('insert returned no user row')
    created.push(row.id)
    return row
  }

  /** A stored session, created the way a sign-in creates one. */
  async function sessionFor(
    userId: string,
    context: { userAgent?: string | null; ipHash?: string | null } = {},
  ) {
    const token = `token-${randomUUID()}`
    const [row] = await db
      .insert(sessions)
      .values({
        tokenHash: token,
        userId,
        csrfTokenHash: `csrf-${randomUUID()}`,
        userAgent: context.userAgent ?? null,
        ipHash: context.ipHash ?? null,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        idleExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning()

    if (!row) throw new Error('insert returned no session row')
    return row
  }

  async function sessionIds(userId: string): Promise<string[]> {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
    return rows.map((row) => row.id)
  }

  afterAll(async () => {
    // Sessions cascade with the user, so only the users need naming.
    if (created.length === 0) return
    await db.delete(users).where(inArray(users.id, created))
  })

  describe('what a row is allowed to carry', () => {
    it('projects the row down to what the screen shows, and no further', async () => {
      const user = await makeUser()
      const session = await sessionFor(user.id, {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36',
        ipHash: 'a'.repeat(64),
      })

      const [listed] = await listUserSessions(user.id)

      // A closed list rather than a spot check. The fields left out —
      // `tokenHash` and `csrfTokenHash` — are what makes a row authenticate, and
      // the guarantee is that the type cannot carry them rather than that this
      // particular caller did not read them: a widened projection fails here
      // instead of quietly handing a page a credential.
      expect(Object.keys(listed!).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'ipHash',
        'lastSeenAt',
        'userAgent',
      ])

      // The stored hashes are not reachable through the projection under any
      // key, which is the assertion that survives a rename.
      const serialized = JSON.stringify(listed)
      expect(serialized).not.toContain(session.tokenHash)
      expect(serialized).not.toContain(session.csrfTokenHash)
    })

    it('derives when the device was last seen from its idle window', async () => {
      const user = await makeUser()
      const session = await sessionFor(user.id)

      // What `touchSession` writes: the idle window restarted now. The list has
      // to read that as "just now" rather than as "in seven days", which is
      // what the raw column says.
      const seenAt = new Date(Date.now() - 60_000)
      await db
        .update(sessions)
        .set({ idleExpiresAt: new Date(seenAt.getTime() + 7 * 86_400_000) })
        .where(eq(sessions.id, session.id))

      const [listed] = await listUserSessions(user.id)

      // Within a second: the arithmetic is exact, and the tolerance is only
      // there because the clock moved between the two statements.
      expect(Math.abs(listed!.lastSeenAt.getTime() - seenAt.getTime())).toBeLessThan(1000)
    })

    it('returns only the sessions of the user it was asked about', async () => {
      const user = await makeUser()
      const other = await makeUser()
      const mine = await sessionFor(user.id)
      const theirs = await sessionFor(other.id)

      const listed = await listUserSessions(user.id)

      expect(listed.map((row) => row.id)).toEqual([mine.id])
      expect(listed.map((row) => row.id)).not.toContain(theirs.id)
    })

    it('orders by creation rather than by activity', async () => {
      const user = await makeUser()
      const first = await sessionFor(user.id)
      const second = await sessionFor(user.id)

      // The newest session is the one most recently used, which is the order a
      // sort by activity would put first. The list is deliberately the other
      // way round, so a request touching a session cannot move a row out from
      // under the cursor of someone about to sign it out.
      await db
        .update(sessions)
        .set({ idleExpiresAt: new Date(Date.now() + 7 * 86_400_000) })
        .where(eq(sessions.id, second.id))

      const listed = await listUserSessions(user.id)

      expect(listed.map((row) => row.id)).toEqual([first.id, second.id])
    })
  })

  describe('signing one device out', () => {
    it('deletes the named session and leaves the rest', async () => {
      const user = await makeUser()
      const kept = await sessionFor(user.id)
      const doomed = await sessionFor(user.id)

      expect(await revokeSession(user.id, doomed.id)).toBe(true)

      expect(await sessionIds(user.id)).toEqual([kept.id])
    })

    it('deletes a session the caller has already signed out without complaining', async () => {
      const user = await makeUser()
      const session = await sessionFor(user.id)

      expect(await revokeSession(user.id, session.id)).toBe(true)

      // The second press is the one that matters: the list on screen is a
      // render old, so "already gone" is an ordinary outcome of a click rather
      // than an error, and it answers the same way a session that was never
      // this user's does.
      expect(await revokeSession(user.id, session.id)).toBe(false)
    })

    it('refuses a session id that belongs to somebody else', async () => {
      const user = await makeUser()
      const other = await makeUser()
      const mine = await sessionFor(user.id)
      const theirs = await sessionFor(other.id)

      // This is the input an attacker chooses: the id travels to the browser
      // and comes back, so nothing stops a request naming a row it does not
      // own. The user id is part of the delete rather than a check before it,
      // so the row survives and the answer is the same false as for a stale
      // one — an attacker learns nothing about whether that id exists.
      expect(await revokeSession(user.id, theirs.id)).toBe(false)

      expect(await sessionIds(other.id)).toEqual([theirs.id])
      expect(await sessionIds(user.id)).toEqual([mine.id])
    })
  })

  describe('signing every other device out', () => {
    it('keeps the session that asked and ends the others', async () => {
      const user = await makeUser()
      const kept = await sessionFor(user.id)
      await sessionFor(user.id)
      await sessionFor(user.id)

      expect(await destroyOtherSessions(user.id, kept.id)).toBe(2)

      expect(await sessionIds(user.id)).toEqual([kept.id])
    })

    it('answers zero rather than failing when there is nothing else signed in', async () => {
      const user = await makeUser()
      const only = await sessionFor(user.id)

      // The button is hidden when this is the state, but the count is what the
      // toast reports, and zero has to be a number rather than an error.
      expect(await destroyOtherSessions(user.id, only.id)).toBe(0)
      expect(await sessionIds(user.id)).toEqual([only.id])
    })

    it('does not reach across accounts', async () => {
      const user = await makeUser()
      const other = await makeUser()
      const mine = await sessionFor(user.id)
      const theirs = await sessionFor(other.id)

      await destroyOtherSessions(user.id, mine.id)

      expect(await sessionIds(other.id)).toEqual([theirs.id])
    })
  })
})
