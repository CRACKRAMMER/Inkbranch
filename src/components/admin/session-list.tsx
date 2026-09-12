import { env } from '@/env'
import type { SessionSummary } from '@/lib/auth/session-store'
import type { DateFormatContext } from '@/lib/utils/date'
import { formatDate, formatRelative } from '@/lib/utils/date'
import { deviceLabel } from '@/lib/utils/device'
import { ConfirmAction } from '@/components/admin/confirm-action'
import { Section } from '@/components/admin/page'
import { revokeOtherSessionsAction, revokeSessionAction } from '@/app/admin/actions/sessions'

/**
 * The devices signed in to this account.
 *
 * ## Why the screen exists
 *
 * Three places already said it did. `sessions.ip_hash` is documented as "used
 * only for the session list in settings", `destroyOtherSessions` as reachable
 * "from the session list in settings", and the sessions table itself as buying
 * "a session list the owner can audit" — and none of the three had a caller,
 * a screen, or a way to be reached. The column was written on every sign-in and
 * read by nothing.
 *
 * What the screen is for is the thing a password change was being used as a
 * proxy for: "I want that laptop signed out" without retiring the credential
 * every other device is holding, including the one in hand.
 *
 * ## Why it is a server component that renders client buttons
 *
 * Nothing on the list is interactive except the two actions, which `ConfirmAction`
 * already handles, so the rows stay on the server — no client bundle, and the
 * relative timestamps are formatted once, on the server, where the site's
 * timezone is known. A client component formatting them would hydrate against
 * whatever timezone the browser has and disagree with the server's render.
 *
 * ## Why the counts in the dialog are not in the toast
 *
 * Both are strings, and both are computed from the render that produced them.
 * The dialog is opened by someone looking at those rows, so its count is the
 * count of what is on screen. The toast outlives that render — a device could
 * have signed in between the render and the click — so it says what happened
 * without a number, and the list refreshes underneath it to say how much.
 *
 * ## Why the last sign-in is a line of its own
 *
 * `users.last_login_at` is written on every successful sign-in and was read by
 * nothing — the same complaint as `sessions.ip_hash` above, one table over, and
 * found the same way. The row is already in hand: `resolveSession` selects the
 * whole user, so this costs no query.
 *
 * It is not the newest row of the table repeated. The table is *live sessions*,
 * and a session ends: the absolute TTL passes, `auth.prune` deletes the row, and
 * the last time anyone got into this account leaves the screen with it. This is
 * the line that stays, which is why it sits outside the table rather than as a
 * column in it, and why it says what it is rather than being left to be inferred.
 */

export interface SessionListProps {
  /** This account's sessions, oldest first, as `listUserSessions` returns them. */
  sessions: SessionSummary[]
  /** The session reading the page. Its row gets no sign-out button. */
  currentSessionId: string
  /** `users.last_login_at`: the account's most recent successful sign-in. */
  lastSignInAt: Date | null
  /** The site's locale and timezone, plus one clock for every relative label. */
  context: DateFormatContext & { now: Date }
}

export function SessionList({
  sessions,
  currentSessionId,
  lastSignInAt,
  context,
}: SessionListProps) {
  const others = sessions.filter((session) => session.id !== currentSessionId)
  const absoluteDays = Math.round(env.SESSION_ABSOLUTE_TTL / 86_400)
  const idleDays = Math.round(env.SESSION_IDLE_TTL / 86_400)

  return (
    <Section
      title="Devices"
      description={`One row per browser signed in to this account, oldest first. Signing one out takes effect on its next request, because the session row is what authenticates. Sessions end by themselves after ${absoluteDays} days, or after ${idleDays} days of not being used. The network column is a fingerprint of the address a device signed in from, not the address itself — two rows that match came from the same place.`}
      actions={
        others.length > 0 ? (
          <ConfirmAction<undefined>
            action={revokeOtherSessionsAction}
            payload={undefined}
            triggerLabel="Sign out other devices"
            triggerVariant="outline"
            title={`Sign out ${others.length} other device${others.length === 1 ? '' : 's'}?`}
            confirmLabel="Sign them out"
            successMessage="Other devices signed out."
            description={
              <>
                <p>
                  Every session for this account except the one you are reading this on stops
                  working at its next request.
                </p>
                <p className="mt-2">
                  This device stays signed in, and the password does not change — so a device
                  that still knows it can sign back in.
                </p>
              </>
            }
          />
        ) : null
      }
    >
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Sessions signed in to this account, oldest first
          </caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                Device
              </th>
              <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                Network
              </th>
              <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                Signed in
              </th>
              <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                Last active
              </th>
              <th scope="col" className="py-2 font-medium text-ink-muted">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const current = session.id === currentSessionId

              return (
                <tr
                  key={session.id}
                  className="border-b border-line align-middle last:border-0"
                >
                  <th
                    scope="row"
                    className="py-2.5 pr-3 text-left text-sm font-normal text-ink"
                  >
                    {deviceLabel(session.userAgent)}
                  </th>
                  <td className="py-2.5 pr-3 font-mono text-xs text-ink-muted">
                    {session.ipHash ? session.ipHash.slice(0, 8) : '—'}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-ink-muted">
                    <time dateTime={session.createdAt.toISOString()}>
                      {formatDate(session.createdAt, context, 'short')}
                    </time>
                    <span className="ml-2">{formatRelative(session.createdAt, context)}</span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-ink-muted">
                    <time dateTime={session.lastSeenAt.toISOString()}>
                      {formatRelative(session.lastSeenAt, context)}
                    </time>
                  </td>
                  <td className="py-2.5">
                    {current ? (
                      // Not a disabled button: there is nothing here to do, and
                      // the header's Sign out is the way to end this one.
                      <span className="text-xs text-ink-subtle">This device</span>
                    ) : (
                      <ConfirmAction
                        action={revokeSessionAction}
                        payload={{ sessionId: session.id }}
                        triggerLabel="Sign out"
                        triggerVariant="ghost"
                        title={`Sign out ${deviceLabel(session.userAgent)}?`}
                        confirmLabel="Sign out"
                        successMessage="Device signed out."
                        description={
                          <p>
                            Its next request is refused and it lands on the sign-in page. The
                            password does not change, so it can sign back in with it.
                          </p>
                        }
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        This account was last signed in to{' '}
        {lastSignInAt ? (
          <>
            <time dateTime={lastSignInAt.toISOString()}>
              {formatDate(lastSignInAt, context, 'short')}
            </time>
            <span className="ml-2">{formatRelative(lastSignInAt, context)}</span>
          </>
        ) : (
          // An account with no recorded sign-in cannot be reading this page —
          // a session only exists because one happened — so this is the honest
          // answer to a row that was edited by hand rather than a state worth
          // designing for.
          <span className="font-mono">—</span>
        )}
        . Unlike the rows above, it survives them: when a session expires it is
        pruned, and the fact that someone got in is not.
      </p>
    </Section>
  )
}
