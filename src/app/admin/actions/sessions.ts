'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'
import { actionOk, type ActionResult } from '@/lib/admin/result'
import { destroyOtherSessions, revokeSession } from '@/lib/auth/session-store'

/**
 * Signing devices out, from the session list in settings.
 *
 * ## Why these exist
 *
 * A server-side session store buys immediate revocation — that is most of the
 * reason to keep sessions in a table at all — and until this screen there was
 * no way to reach for it. The only sign-out was the header's, which ends the
 * session in hand and leaves every other one running, and the only way to
 * revoke those was to change the password: a heavier, credential-touching act
 * used as a proxy for "I want that laptop signed out".
 *
 * ## Why there is no rate limit
 *
 * Every other mutating action here has one, and the reason this does not is
 * that a limiter bounds guessing. There is nothing to guess: the session ids
 * are uuids the caller already owns, both operations delete only rows belonging
 * to the account that is asking, and both are idempotent. A bucket would
 * therefore spend its whole existence refusing an owner who is signing out
 * devices — which is exactly the thing an owner does when they think someone
 * else is in their account, and the worst moment to answer "too many attempts".
 *
 * The nuisance case is real and is not what a rate limit fixes: whoever holds a
 * stolen session can already do everything the owner can, including this. It is
 * recorded instead, so the log says when it happened.
 */

const revokeSchema = z.object({
  sessionId: z.uuid(),
})

export interface SessionsRevoked {
  /**
   * How many sessions this call ended.
   *
   * Zero is a real answer and not a failure — see `revokeSessionAction`.
   */
  revoked: number
}

/**
 * Sign out one device.
 *
 * ## Why "nothing was deleted" is a success
 *
 * `revokeSession` answers false for a session that is not this user's and for
 * one that is already gone, without distinguishing them, so the action cannot
 * report which happened and does not try. Both mean the same thing to the
 * operator — the row on screen is stale — and the honest response is to say so
 * and re-render the list, which is what a zero count does here. A failure would
 * leave the dialog open over a row that is about to disappear anyway.
 */
export async function revokeSessionAction(input: unknown): Promise<ActionResult<SessionsRevoked>> {
  try {
    const context = await guardAction()

    const parsed = parseActionInput(revokeSchema, input)
    if (!parsed.ok) return parsed

    const deleted = await revokeSession(context.user.id, parsed.value.sessionId)

    // Recorded either way: a count of zero against a session id the caller
    // named is the shape of a request that asked to sign out something it does
    // not own, and that is worth having in the log even though the answer to
    // the browser is the same as for a stale row.
    await recordAudit({
      action: 'auth.session_revoked',
      actorId: context.user.id,
      targetType: 'session',
      targetId: parsed.value.sessionId,
      metadata: { revoked: deleted ? 1 : 0 },
      request: context.request,
    })

    revalidatePath('/admin/settings')

    return actionOk({ revoked: deleted ? 1 : 0 })
  } catch (error) {
    return describeActionError(error)
  }
}

/** Sign out every device except the one asking. */
export async function revokeOtherSessionsAction(): Promise<ActionResult<SessionsRevoked>> {
  try {
    const context = await guardAction()

    const revoked = await destroyOtherSessions(context.user.id, context.session.id)

    // Targets the account rather than a session, because there is no single
    // session to name — and the count is the fact worth recording: it is what
    // tells a later reader whether this ran against an account with four
    // devices signed in or none.
    await recordAudit({
      action: 'auth.session_revoked',
      actorId: context.user.id,
      targetType: 'user',
      targetId: context.user.id,
      metadata: { revoked, scope: 'others' },
      request: context.request,
    })

    revalidatePath('/admin/settings')

    return actionOk({ revoked })
  } catch (error) {
    return describeActionError(error)
  }
}
