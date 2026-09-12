import type { Metadata } from 'next'
import Link from 'next/link'

import { requireSession } from '@/lib/auth/session'
import { listUserSessions } from '@/lib/auth/session-store'
import { SETTINGS_DEFAULTS, SETTINGS_KEYS, getSettings } from '@/lib/settings'
import { InlineNote, Page, Section } from '@/components/admin/page'
import { SessionList } from '@/components/admin/session-list'
import { SettingsForm } from '@/components/admin/settings-form'
import { PasswordForm } from '@/components/admin/password-form'

export const metadata: Metadata = { title: 'Settings' }

/**
 * The site's configuration.
 *
 * One row in `site_settings`, read through the settings module and written back
 * as a patch of the keys that changed. The form is a client component because it
 * has to know what changed before it sends anything — the patch is computed from
 * the difference against the last saved state, not from what happens to be on
 * screen.
 *
 * The page says which settings nothing reads yet. That is a fact about the build
 * rather than about this page, and it belongs next to the switch it concerns:
 * an operator who turns on the git integration and finds no commits should learn
 * that here, not from a support thread.
 *
 * Two blocks below the form are about the account rather than the site: the
 * password, and the devices signed in with it. Neither is a setting — both live
 * on their own tables — and the second is what three comments elsewhere in the
 * codebase had been promising for as long as they had existed.
 */
export default async function SettingsPage() {
  // The session rather than the user: the device list below marks the row for
  // the browser that is asking and leaves it out of the sign-out buttons, which
  // needs the session's own id and not just who it belongs to.
  const current = await requireSession()

  const [settings, sessions] = await Promise.all([
    getSettings(),
    listUserSessions(current.user.id),
  ])

  const customised = SETTINGS_KEYS.filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(SETTINGS_DEFAULTS[key]),
  )

  // One clock for the whole render, so two rows created in the same minute
  // cannot come out as "1 minute ago" and "2 minutes ago".
  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }

  return (
    <Page
      title="Settings"
      measure="prose"
      description="Read by the site's layout, metadata, feeds and the admin itself. A write is recorded in the database and the public tree is invalidated with it, so the next request for any page renders against the new values."
    >
      {customised.length === 0 ? (
        <InlineNote>
          Every setting in this table still holds its default value, so nothing here has been
          configured yet.
        </InlineNote>
      ) : null}

      <SettingsForm settings={settings} />

      {/*
        Below the settings form rather than inside it, and a form of its own.
        The password is not a setting: it lives on the user row, it is not part
        of `settingsPatchSchema`, and folding it into that form would mean the
        patch that saves a tagline could also carry a credential.
      */}
      <div className="mt-14 border-t border-line pt-2">
        <Section
          title="Password"
          description="The account's own credential. Changing it signs out every other device and keeps this one signed in."
        >
          <PasswordForm />
        </Section>
      </div>

      {/*
        The device list below the password, and in its own divided block for the
        same reason: it is not a setting either. It is the state of the account's
        sessions, and the two halves answer each other — the password change
        signs every other device out, and this is where a single one can be
        signed out without it.
      */}
      <div className="mt-14 border-t border-line pt-2">
        <SessionList
          sessions={sessions}
          currentSessionId={current.session.id}
          context={context}
        />
      </div>

      <p className="mt-6 text-xs leading-relaxed text-ink-subtle">
        Settings live in one database row, not in files — a change here does not touch the working
        tree, and every reader of it picks the new value up on its next render. Writes are recorded
        in the{' '}
        <Link href="/admin/system#audit" className="text-brand underline underline-offset-2">
          audit log
        </Link>
        .
      </p>
    </Page>
  )
}
