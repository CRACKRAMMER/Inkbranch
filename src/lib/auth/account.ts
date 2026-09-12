import { and, eq, ne, sql } from 'drizzle-orm'

import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { sessions, users } from '@/lib/db/schema'

import { hashPassword, verifyPassword } from './password'

/**
 * The owner's own account.
 *
 * ## Why this exists, and why it is where the session version is written
 *
 * `users.session_version` was added with the sessions table and documented as
 * the thing a password change bumps; `sessions.session_version` mirrors it, and
 * `resolveSession` refuses a session whose copy has fallen behind. All three
 * halves were written and none of them was ever exercised, because nothing in
 * the application changed a password: the columns' promise — "bump this and
 * every existing session dies" — was a comment, not a mechanism. The seed
 * pointed the operator at a screen that did not exist ("Its password was not
 * changed. Use the admin to change it."), and the only way to rotate the
 * credential was to edit the database by hand.
 *
 * The rule this module exists to keep true is therefore narrow and absolute:
 * **a password is written and the session version is bumped in the same
 * transaction, or neither happens.** Anything that writes `password_hash`
 * alone leaves live sessions that the owner believes they have revoked.
 *
 * ## One mechanism for the invalidation, not two
 *
 * The version bump is what makes a session invalid: `resolveSession` compares
 * the row's copy against the user's and returns null when they differ. Deleting
 * the other rows happens here as well, but it is reclamation rather than the
 * rule — it is what lets the caller report how many devices were signed out,
 * and what keeps a table whose only purpose is live sessions from holding rows
 * that are known dead.
 *
 * They are not two answers to one question, and the difference is a race that
 * is worth naming because it is the reason the version check cannot be dropped
 * in favour of the delete: a sign-in that reads `session_version` *before* this
 * transaction commits, and inserts its row after this transaction's delete has
 * run, leaves a row the delete never saw. That row carries the old version, so
 * the comparison rejects it — and only the comparison does.
 */

export type PasswordChangeRefusal = 'wrong-password' | 'unchanged'

export class PasswordChangeError extends Error {
  readonly code = 'PASSWORD_CHANGE'
  readonly refusal: PasswordChangeRefusal

  constructor(refusal: PasswordChangeRefusal, message: string) {
    super(message)
    this.name = 'PasswordChangeError'
    this.refusal = refusal
  }
}

export interface PasswordChangeInput {
  userId: string
  /** Proves the request is the owner's, not someone holding a stolen session. */
  currentPassword: string
  newPassword: string
  /**
   * The session making the change.
   *
   * It is re-stamped rather than spared, and it is the only one that is. Every
   * other session is revoked: an owner changes their password precisely when
   * they suspect a device they no longer control, and a form that asked which
   * sessions to keep would be asking them to make that judgement at the moment
   * they know least about it.
   */
  keepSessionId: string
}

export interface PasswordChangeOutcome {
  /** Sessions the change revoked, not counting the one that made it. */
  revoked: number
}

/**
 * Change a password, and revoke every other session with it.
 *
 * The two refusals are separate on purpose. "That is not your current password"
 * and "that is the password you already have" need different sentences next to
 * different fields, and collapsing them into one failure would leave the owner
 * retyping the wrong box.
 */
export async function changePassword(
  input: PasswordChangeInput,
  actor: { ipHash: string | null },
): Promise<PasswordChangeOutcome> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)

  // Unreachable through the admin: the session this was called with was
  // resolved by an inner join onto this row. It is an error rather than a
  // refusal because it means the two reads disagreed, which is not something to
  // report to the browser as a bad password.
  if (!user) throw new Error(`Cannot change the password of unknown user ${input.userId}`)

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new PasswordChangeError(
      'wrong-password',
      'That is not the password this account currently has.',
    )
  }

  // Checked against the stored hash rather than by comparing the two submitted
  // strings: the new password is verified against the old hash, so "unchanged"
  // means unchanged to Argon2 and not merely identical on screen.
  if (await verifyPassword(user.passwordHash, input.newPassword)) {
    throw new PasswordChangeError(
      'unchanged',
      'That is the password this account already has, so nothing was changed.',
    )
  }

  const passwordHash = await hashPassword(input.newPassword)

  const outcome = await db.transaction(async (tx) => {
    // `session_version + 1` rather than a value read a moment ago: two changes
    // that raced would otherwise both write the same number, and the second
    // would silently un-invalidate nothing.
    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, input.userId))
      .returning({ sessionVersion: users.sessionVersion })

    if (!updated) throw new Error(`User ${input.userId} disappeared mid-transaction`)

    // The session that made the change carries the new version, so it survives
    // the comparison that is about to kill every other one. A row left at the
    // old number would be a dead row that merely looked alive.
    await tx
      .update(sessions)
      .set({ sessionVersion: updated.sessionVersion })
      .where(and(eq(sessions.id, input.keepSessionId), eq(sessions.userId, input.userId)))

    const revoked = await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, input.userId), ne(sessions.id, input.keepSessionId)))
      .returning({ id: sessions.id })

    return { revoked: revoked.length }
  })

  // After the transaction, not inside it: the audit log is evidence that the
  // change happened, and a write that never throws must not be able to hold the
  // change open or roll it back. No password, no hash, no token — the count of
  // revoked sessions is the only fact here that is not already in the row.
  await recordAudit({
    action: 'auth.password_changed',
    actorId: input.userId,
    targetType: 'user',
    targetId: input.userId,
    metadata: { revoked: outcome.revoked },
    request: { ipHash: actor.ipHash },
  })

  return outcome
}
