import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { renderDocument } from '@/lib/content/render'
import {
  AUTOSAVE_SUMMARY,
  RevisionNotFoundError,
  getRevision,
  listRevisions,
} from '@/lib/revision/store'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'
import { loadEditorDocument } from '@/lib/admin/documents'
import { indexSlugKeys } from '@/lib/admin/queries'
import { revisionAuthors } from '@/lib/admin/revisions'
import { typeFromSegment } from '@/lib/admin/routes'
import { InlineNote, Page, Section } from '@/components/admin/page'
import { RestoreRevisionButton } from '@/components/admin/revision-restore'
import { Badge } from '@/components/ui/badge'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; slug: string; revisionId: string }>
}): Promise<Metadata> {
  const { revisionId } = await params
  try {
    const revision = await getRevision(revisionId)
    return { title: `Revision #${revision.revisionNo}` }
  } catch {
    // A revision that cannot be read is a 404 by the time the page renders;
    // the title only has to avoid claiming otherwise.
    return { title: 'Revision' }
  }
}

/**
 * One revision, as it was.
 *
 * The snapshot is a complete file — frontmatter included — so the page shows it
 * as a person will recognise it: the rendered body, with the metadata beside it
 * rather than mixed into the text. The YAML is shown raw underneath, because the
 * point of a revision viewer is being able to recover something you lost, and
 * that includes the header's exact spelling.
 */
export default async function RevisionDetailPage({
  params,
}: {
  params: Promise<{ type: string; slug: string; revisionId: string }>
}) {
  await requireUser()

  const { type: segment, slug, revisionId } = await params
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const document = await loadEditorDocument(type, slug)
  if (!document || !document.contentId) notFound()

  let revision
  try {
    revision = await getRevision(revisionId)
  } catch (error) {
    if (error instanceof RevisionNotFoundError) notFound()
    throw error
  }

  if (revision.contentId !== document.contentId) notFound()

  const [settings, siblings, authors, knownSlugs] = await Promise.all([
    getSettings(),
    listRevisions(document.contentId, { limit: 100 }),
    revisionAuthors([revision.authorId ?? '']),
    indexSlugKeys(),
  ])

  const parsed = parseFrontmatter(revision.content)
  const { html } = await renderDocument(parsed.content, { knownSlugs: new Set(knownSlugs) })
  const now = new Date()
  const context = { locale: settings.locale, timeZone: settings.timezone, now }
  const isCurrent = revision.contentHash === document.checksum
  const others = siblings.filter((entry) => entry.id !== revision.id)
  const autosave = revision.summary === AUTOSAVE_SUMMARY
  const listHref = `/admin/${segment}/${document.slug}/revisions`

  return (
    <Page
      eyebrow={`Revision #${revision.revisionNo}`}
      title={revision.title}
      description={
        <>
          Recorded {formatDate(revision.createdAt, context)} ({formatRelative(revision.createdAt, context)})
          {revision.authorId
            ? ` by ${authors.get(revision.authorId) ?? 'a deleted account'}`
            : ' by the command line'}
          .
        </>
      }
      actions={
        <>
          <Link href={listHref} className="text-sm text-ink-muted hover:text-brand">
            ← All revisions
          </Link>
          <RestoreRevisionButton
            revisionId={revision.id}
            revisionNo={revision.revisionNo}
            createdAt={formatDate(revision.createdAt, context)}
            additions={revision.additions}
            deletions={revision.deletions}
          />
        </>
      }
    >
      {isCurrent ? (
        <InlineNote>
          This revision is byte-for-byte what is on disk right now — nothing has been saved since it
          was recorded. Restoring it would rewrite the same contents.
        </InlineNote>
      ) : null}

      <Section title="Metadata" description="The frontmatter this revision carried.">
        <dl className="divide-y divide-line border-y border-line text-sm">
          {Object.entries(parsed.data).map(([key, value]) => (
            <div key={key} className="flex gap-4 py-2">
              <dt className="w-40 shrink-0 font-mono text-xs text-ink-muted">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-ink">
                {formatValue(value)}
              </dd>
            </div>
          ))}
        </dl>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-ink">
            Raw file, exactly as it was stored
          </summary>
          <pre className="mt-3 max-h-[24rem] overflow-auto border border-line bg-sunken p-3 font-mono text-xs text-ink">
            <code>{revision.content}</code>
          </pre>
        </details>
      </Section>

      <Section
        title="Contents"
        description={
          autosave
            ? 'An autosave stores the buffer as typed, not the state it replaced, so it carries no diff statistics — the metadata above is what it was.'
            : `What this save replaced: +${revision.additions} / −${revision.deletions} lines.`
        }
        actions={
          others.length > 0 ? (
            <Link
              href={`/admin/${segment}/${document.slug}/revisions/compare?from=${revision.id}&to=${others[0]?.id}`}
              className="text-sm text-brand underline underline-offset-2"
            >
              Compare with #{others[0]?.revisionNo}
            </Link>
          ) : null
        }
      >
        <article className="prose border border-line px-5 py-4">
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </Section>

      {others.length > 0 ? (
        <Section title="Compare" description="See this revision against another one.">
          <form
            method="get"
            action={`/admin/${segment}/${document.slug}/revisions/compare`}
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="from" value={revision.id} />
            <label className="text-sm">
              <span className="mb-1 block text-xs text-ink-muted">Compare with</span>
              <select
                name="to"
                defaultValue={others[0]?.id}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {others.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    #{entry.revisionNo} · {entry.summary} ·{' '}
                    {formatDate(entry.createdAt, context)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="h-9 rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-sunken"
            >
              Show the difference
            </button>
          </form>
          <p className="mt-2 text-xs text-ink-subtle">
            The diff reads left to right: this revision first, the one you pick second.
          </p>
        </Section>
      ) : (
        <InlineNote>This is the only revision of this document, so there is nothing to compare.</InlineNote>
      )}

      <p className="mt-8 text-xs text-ink-subtle">
        <Link href={`/admin/${segment}/${document.slug}/edit`} className="text-brand underline underline-offset-2">
          Back to the editor
        </Link>{' '}
        · <span className="font-mono">{document.path}</span>
        {autosave ? <Badge variant="outline">autosave</Badge> : null}
      </p>
    </Page>
  )
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value || '""'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formatValue).join(', ')
  if (typeof value === 'object') {
    return serializeInline(value as Record<string, unknown>)
  }
  return String(value)
}

/** Objects in frontmatter are one level deep in practice; show them as `key: value` lines. */
function serializeInline(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${formatValue(entry)}`)
    .join('\n')
}
