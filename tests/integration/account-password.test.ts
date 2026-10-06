import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'

import { hasTestDatabase } from '../setup'

import { PasswordChangeError, changePassword } from '@/lib/auth/account'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import * as passwordModule from '@/lib/auth/password'
import { CredentialChangedError, createSession, resolveSession } from '@/lib/auth/session-store'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { auditLogs, sessions, users } from '@/lib/db/schema'

/**
 * Changing the password, and the revocation that is supposed to come with it.
 *
 * ## Why this file exists
 *
 * `users.session_version`, the `sessions` copy of it, and the comparison in
 * `resolveSession` that refuses a session whose copy has fallen behind were all
 * written before this file was, and none of them had ever run: nothing in the
 * application changed a password, so the mechanism was a comment. The columns
 * said a password change invalidates every session; no password change existed;
 * a test that read the code and believed the comment would have passed.
 *
 * So these assertions are about the seam rather than about the function. A
 * change that wrote `password_hash` and forgot the version would satisfy every
 * test of "the new password works" — that is exactly the state the codebase was
 * in — and it is the session assertions below, not the hash assertion, that
 * fail when it happens.
 *
 * ## Why the version check is tested separately from the revocation
 *
 * They are not two ways of saying the same thing, and the delete is not a
 * substitute for the comparison: a sign-in that read the version before this
 * change committed and inserted its row afterwards is invisible to the delete
 * and is caught by nothing but the comparison. That row is constructed directly
 * below, because the alternative is racing two transactions and hoping.
 */

const OLD_PASSWORD = 'the-password-being-retired'
const NEW_PASSWORD = 'a-different-password-entirely'

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('changing the password', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  /** Every user this file created, so cleanup can remove exactly those. */
  const created: string[] = []

  /**
   * A user of this file's own, rather than the seeded owner.
   *
   * The suite shares one database with every other integration file, and the
   * owner row is what the E2E run signs in as. A test that rotated *that*
   * password would take the whole end-to-end suite with it.
   */
  async function makeUser(password = OLD_PASSWORD) {
    const [row] = await db
      .insert(users)
      .values({
        email: `account-${randomUUID()}@test.invalid`,
        name: 'Account Test',
        passwordHash: await hashPassword(password),
      })
      .returning()

    if (!row) throw new Error('insert returned no user row')
    created.push(row.id)
    return row
  }

  /** The user row as it now stands, read fresh rather than from the insert. */
  async function readUser(id: string) {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
    if (!row) throw new Error(`user ${id} is gone`)
    return row
  }

  async function userSessions(userId: string) {
    return db.select().from(sessions).where(eq(sessions.userId, userId))
  }

  afterAll(async () => {
    if (created.length === 0) return
    // Audit rows first, and by actor: `audit_logs.user_id` is `on delete set
    // null`, so deleting the user first would leave rows this file wrote
    // pointing at nobody — and other suites count rows in that table.
    await db.delete(auditLogs).where(inArray(auditLogs.userId, created))
    await db.delete(users).where(inArray(users.id, created))
  })

  it('signs out every other session and keeps the one that asked', async () => {
    const user = await makeUser()
    const kept = await createSession(user.id, { userAgent: 'the device making the change' })
    const other = await createSession(user.id, { userAgent: 'the device being signed out' })

    const outcome = await changePassword(
      {
        userId: user.id,
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        keepSessionId: kept.session.id,
      },
      { ipHash: null },
    )

    expect(outcome.revoked).toBe(1)
    expect(await resolveSession(other.token)).toBeNull()
    expect(await resolveSession(kept.token)).not.toBeNull()

    // Asserted on the rows as well as through `resolveSession`, because "the
    // session no longer resolves" and "the session is gone" are different
    // claims and only the second one keeps the table honest.
    const remaining = await userSessions(user.id)
    expect(remaining.map((row) => row.id)).toEqual([kept.session.id])
  })

  it('stores the new password and retires the old one', async () => {
    const user = await makeUser()
    const kept = await createSession(user.id, { userAgent: null })

    await changePassword(
      {
        userId: user.id,
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        keepSessionId: kept.session.id,
      },
      { ipHash: null },
    )

    const after = await readUser(user.id)
    expect(await verifyPassword(after.passwordHash, NEW_PASSWORD)).toBe(true)
    expect(await verifyPassword(after.passwordHash, OLD_PASSWORD)).toBe(false)
    expect(after.sessionVersion).toBe(user.sessionVersion + 1)
  })

  it('leaves everything alone when the current password is wrong', async () => {
    const user = await makeUser()
    const session = await createSession(user.id, { userAgent: null })

    const refusal = await changePassword(
      {
        userId: user.id,
        currentPassword: 'not-the-password-at-all',
        newPassword: NEW_PASSWORD,
        keepSessionId: session.session.id,
      },
      { ipHash: null },
    ).then(
      () => null,
      (error: unknown) => error,
    )

    expect(refusal).toBeInstanceOf(PasswordChangeError)
    expect(refusal).toMatchObject({ refusal: 'wrong-password' })

    // Nothing moved: not the hash, not the version, and not the session the
    // caller would have had to sign in again with.
    const after = await readUser(user.id)
    expect(after.passwordHash).toBe(user.passwordHash)
    expect(after.sessionVersion).toBe(user.sessionVersion)
    expect(await resolveSession(session.token)).not.toBeNull()
  })

  it('refuses a new password that is the one already stored', async () => {
    const user = await makeUser()
    const session = await createSession(user.id, { userAgent: null })

    // A rotation that rotates nothing is worth refusing rather than accepting:
    // the owner who does it believes an exposed password has been retired, and
    // a success message would tell them so.
    const refusal = await changePassword(
      {
        userId: user.id,
        currentPassword: OLD_PASSWORD,
        newPassword: OLD_PASSWORD,
        keepSessionId: session.session.id,
      },
      { ipHash: null },
    ).then(
      () => null,
      (error: unknown) => error,
    )

    expect(refusal).toMatchObject({ refusal: 'unchanged' })

    const after = await readUser(user.id)
    expect(after.sessionVersion).toBe(user.sessionVersion)
  })

  it('refuses a session carrying a version the user has moved past', async () => {
    const user = await makeUser()
    const kept = await createSession(user.id, { userAgent: null })

    await changePassword(
      {
        userId: user.id,
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        keepSessionId: kept.session.id,
      },
      { ipHash: null },
    )

    // The sign-in that read `session_version` before the change committed and
    // inserted its row after the change's delete had already run. The delete
    // cannot see this row — it did not exist yet — so nothing but the
    // comparison in `resolveSession` stands between it and a working session
    // holding a password that has been retired.
    const stale = await createSession(user.id, { userAgent: 'raced with the change' })
    await db
      .update(sessions)
      .set({ sessionVersion: user.sessionVersion })
      .where(eq(sessions.id, stale.session.id))

    expect(await resolveSession(stale.token)).toBeNull()
    // And it is gone, not merely refused: a row that authenticates nothing has
    // no reason to stay in a table of live sessions.
    expect((await userSessions(user.id)).map((row) => row.id)).toEqual([kept.session.id])
  })

  it('cannot mint a current session from a credential verified before a password change', async () => {
    const user = await makeUser()
    const kept = await createSession(user.id)
    expect(await verifyPassword(user.passwordHash, OLD_PASSWORD)).toBe(true)

    await changePassword({
      userId: user.id,
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      keepSessionId: kept.session.id,
    }, { ipHash: null })

    await expect(createSession(user.id, {
      expectedSessionVersion: user.sessionVersion,
    })).rejects.toBeInstanceOf(CredentialChangedError)
    expect((await userSessions(user.id)).map((row) => row.id)).toEqual([kept.session.id])
  })

  it('allows only one of two password changes that verified the same retired credential', async () => {
    const user = await makeUser()
    const first = await createSession(user.id)
    const second = await createSession(user.id)
    const originalHash = passwordModule.hashPassword
    let arrived = 0
    let release!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(passwordModule, 'hashPassword').mockImplementation(async (value) => {
      // Both calls have verified the original hash by the time hashing starts.
      arrived += 1
      if (arrived === 2) release()
      await ready
      return originalHash(value)
    })

    try {
      const outcomes = await Promise.allSettled([
        changePassword({ userId: user.id, currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD, keepSessionId: first.session.id }, { ipHash: null }),
        changePassword({ userId: user.id, currentPassword: OLD_PASSWORD,
          newPassword: 'another-password-that-must-not-overwrite',
          keepSessionId: second.session.id }, { ipHash: null }),
      ])
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const refused = outcomes.find((result) => result.status === 'rejected')
      expect(refused).toMatchObject({
        status: 'rejected', reason: { refusal: 'credential-changed' },
      })
      expect((await readUser(user.id)).sessionVersion).toBe(user.sessionVersion + 1)
      expect(await userSessions(user.id)).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('records the change in the audit log without recording a credential', async () => {
    const user = await makeUser()
    const session = await createSession(user.id, { userAgent: null })

    // The ids that were there before, rather than an empty table: another suite
    // is writing audit rows into this database as this one runs.
    const before = new Set(
      (await db.select({ id: auditLogs.id }).from(auditLogs)).map((row) => row.id),
    )

    await changePassword(
      {
        userId: user.id,
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        keepSessionId: session.session.id,
      },
      { ipHash: null },
    )

    const written = (await db.select().from(auditLogs)).filter((row) => !before.has(row.id))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      action: 'auth.password_changed',
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      outcome: 'ok',
      meta: { revoked: 0 },
    })

    // The audit log is read by the admin's own pages and included in backups,
    // so a password reaching it would be a copy of the credential in two more
    // places than it belongs.
    const serialized = JSON.stringify(written[0]?.meta ?? {})
    expect(serialized).not.toContain(NEW_PASSWORD)
    expect(serialized).not.toContain(OLD_PASSWORD)
  })
})
