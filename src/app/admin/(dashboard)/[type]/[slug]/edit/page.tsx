import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import { getSettings } from '@/lib/settings'
import { loadEditorDocument } from '@/lib/admin/documents'
import { typeFromSegment } from '@/lib/admin/routes'
import { Editor } from '@/components/admin/editor/editor'

/**
 * The document editor.
 *
 * The page is a thin loader: it authenticates, resolves the segment to a type,
 * reads the file and hands the buffer to a client component. Everything about
 * editing — autosave, the preview, the unsaved-changes guard — is interaction,
 * and interaction belongs on the client; everything about *loading* a document
 * belongs on the server, where the file and the index are.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; slug: string }>
}): Promise<Metadata> {
  const { type, slug } = await params
  const kind = typeFromSegment(type)
  if (!kind) return { title: 'Not found' }

  const document = await loadEditorDocument(kind, slug)
  return { title: document ? `Edit ${document.values.title || document.derivedTitle}` : 'Not found' }
}

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ type: string; slug: string }>
}) {
  await requireUser()

  const { type: segment, slug } = await params
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const [document, settings] = await Promise.all([
    loadEditorDocument(type, slug),
    getSettings(),
  ])

  if (!document) notFound()

  return (
    <Editor
      doc={{
        type: document.type,
        slug: document.slug,
        path: document.path,
        status: document.status,
        checksum: document.checksum,
        body: document.body,
        values: document.values,
        preserved: document.preserved,
        wordCount: document.wordCount,
        updatedAt: document.updatedAt.toISOString(),
        derivedTitle: document.derivedTitle,
        driftedFromIndex: document.driftedFromIndex,
      }}
      locale={settings.locale}
      listHref={`/admin/${segment}`}
      segment={segment}
    />
  )
}
