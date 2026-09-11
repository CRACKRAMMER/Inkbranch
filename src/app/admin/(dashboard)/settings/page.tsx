import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth/session'
import { SETTINGS_DEFAULTS, SETTINGS_KEYS, getSettings } from '@/lib/settings'
import { InlineNote, Page } from '@/components/admin/page'
import { SettingsForm } from '@/components/admin/settings-form'

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
 */
export default async function SettingsPage() {
  await requireUser()

  const settings = await getSettings()
  const customised = SETTINGS_KEYS.filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(SETTINGS_DEFAULTS[key]),
  )

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
