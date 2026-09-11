import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth/session'
import { getSettings } from '@/lib/settings'
import { Page, Section } from '@/components/admin/page'
import { Button } from '@/components/ui/button'
import { IMPORT_LIMITS } from '@/lib/content/import'
import { ImportForm } from './import-form'

export const metadata: Metadata = { title: 'Import' }

/**
 * Bring in Markdown that was written somewhere else.
 *
 * The screen is the engine's four steps, in order and one per screenful: choose a
 * source, read the report, confirm, see what happened. The report is shown in
 * full — every problem, with the fix — because the alternative (a count of
 * "3 files need attention") sends the operator back to the filesystem to find out
 * which.
 *
 * The page renders nothing that writes. The only way any of this touches the
 * content tree is the Confirm button, which submits the same source again and is
 * checked against the fingerprint of the report that was on screen.
 */
export default async function ImportPage() {
  // `(dashboard)` checks this too; a page reached through a different layout
  // after a route move must not be the one that forgets.
  await requireUser()
  const settings = await getSettings()

  return (
    <Page
      title="Import"
      eyebrow={settings.siteName}
      description="Import Markdown from a ZIP archive, from files on this machine, or from a directory on the server. Nothing is written until you confirm a report."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/admin">Back to dashboard</Link>
        </Button>
      }
    >
      <Section
        title="Source"
        description={`Markdown only (${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MiB per file). An archive is read in memory and never unpacked to disk.`}
      >
        <ImportForm />
      </Section>
    </Page>
  )
}
