import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { TYPE_COPY, typeFromSegment } from '@/lib/admin/routes'
import { requireUser } from '@/lib/auth/session'
import { NewContentForm } from './new-content-form'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>
}): Promise<Metadata> {
  const type = typeFromSegment((await params).type)
  return { title: type ? `New ${type}` : 'New document' }
}

/**
 * Create a document.
 *
 * Deliberately short. A new document needs a title and a URL; everything else —
 * description, tags, cover, SEO — is edited in the editor, where the preview is
 * on screen and the fields are next to the thing they describe. Creating the
 * file here and then editing it also means the editor always works on a document
 * that exists on disk, which is what lets autosave record revisions against a
 * real index row.
 */
export default async function NewContentPage({
  params,
}: {
  params: Promise<{ type: string }>
}) {
  await requireUser()

  const segment = (await params).type
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const copy = TYPE_COPY[type]

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-subtle">{copy.plural}</p>
        <h1 className="mt-2 font-serif text-2xl tracking-tight text-ink">{copy.newLabel}</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
          This creates the Markdown file and opens the editor. Nothing is published until you set a
          status and save.
        </p>
      </header>

      <NewContentForm type={type} segment={segment} />

      <p>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/${segment}`}>Back to {copy.plural.toLowerCase()}</Link>
        </Button>
      </p>
    </div>
  )
}
