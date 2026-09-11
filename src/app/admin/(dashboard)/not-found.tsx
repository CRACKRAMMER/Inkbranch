import Link from 'next/link'

import { Page } from '@/components/admin/page'

/**
 * The admin's 404, rendered inside the admin shell.
 *
 * The root 404 is written for a reader and says the page does not exist. Here
 * that sentence is usually false in a way worth naming: an admin URL that
 * resolves to nothing is normally a document that is not in the index — deleted
 * on disk, renamed outside the admin, or never synced — and the operator's next
 * move is a sync, not a trip back to the home page.
 */
export default function AdminNotFound() {
  return (
    <Page title="Not found" measure="prose" eyebrow="404">
      <p className="text-sm leading-relaxed text-ink-muted">
        There is nothing at this address. An admin URL that reaches this page is a document, asset,
        tag or revision that the admin could not find — which is not the same as it not existing. A
        file that was deleted, renamed or written outside the admin is gone from the index while it
        is still on disk, and the reverse happens too: the index can hold a row for a file that has
        since been removed.
      </p>
      <p className="mt-4 text-sm leading-relaxed text-ink-muted">
        A sync reconciles the two and reports what it changed. It reads the Markdown files and
        updates the index — it never writes to a document.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-4 text-sm">
        <Link href="/admin" className="text-brand underline underline-offset-2">
          Dashboard
        </Link>
        <Link href="/admin/system#queue" className="text-brand underline underline-offset-2">
          Check the index for drift
        </Link>
        <Link href="/admin/posts" className="text-brand underline underline-offset-2">
          All posts
        </Link>
      </div>
    </Page>
  )
}
