import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import { AUTOSAVE_SUMMARY, DEFAULT_REVISION_LIMIT, listRevisions } from '@/lib/revision/store'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'
import { formatBytes } from '@/lib/utils/format'
import { loadEditorDocument } from '@/lib/admin/documents'
import { countRevisions, revisionAuthors, revisionStats } from '@/lib/admin/revisions'
import { TYPE_COPY, typeFromSegment } from '@/lib/admin/routes'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { Badge } from '@/components/ui/badge'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; slug: string }>
}): Promise<Metadata> {
  const { type, slug } = await params
  const kind = typeFromSegment(type)
  if (!kind) return { title: 'Not found' }
  const document = await loadEditorDocument(kind, slug)
  return { title: document ? `Revisions · ${document.values.title || document.derivedTitle}` : 'Not found' }
}

/**
 * A document's revision history.
 *
 * The list is metadata only — no snapshot is decompressed to render it — and
 * each row is a link to the viewer, where the contents are. Comparing is a
 * separate page so that a diff is a URL: something you can send to yourself, or
 * keep in a tab, rather than a transient piece of state.
 */
export default async function RevisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; slug: string }>
  searchParams: Promise<{ limit?: string }>
}) {
  await requireUser()

  const [{ type: segment, slug }, query] = await Promise.all([params, searchParams])
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const document = await loadEditorDocument(type, slug)
  if (!document || !document.contentId) {
    notFound()
  }

  const limit = clampLimit(query.limit)
  const [revisions, total, stats, settings] = await Promise.all([
    listRevisions(document.contentId, { limit }),
    countRevisions(document.contentId),
    revisionStats(document.contentId),
    getSettings(),
  ])

  const authors = await revisionAuthors(revisions.map((revision) => revision.authorId ?? ''))
  const now = new Date()
  const context = { locale: settings.locale, timeZone: settings.timezone, now }
  const title = document.values.title || document.derivedTitle

  return (
    <Page
      eyebrow={TYPE_COPY[type].plural}
      title={`Revisions · ${title}`}
      description={
        <>
          A revision is the contents a write replaced, stored in Postgres when the write succeeded.
          The Markdown file is still the document; this is its history.
        </>
      }
      actions={
        <>
          <Link
            href={`/admin/${segment}/${document.slug}/edit`}
            className="text-sm text-ink-muted hover:text-brand"
          >
            Back to the editor
          </Link>
          <Link
            href={`/admin/${segment}/${document.slug}/revisions/compare`}
            className="text-sm text-brand underline underline-offset-2"
          >
            Compare two revisions
          </Link>
        </>
      }
    >
      <StatRow>
        <StatCell>
          <Stat label="Revisions" value={stats.total} />
        </StatCell>
        <StatCell>
          <Stat label="Named saves" value={stats.total - stats.autosaves} />
        </StatCell>
        <StatCell>
          <Stat label="Autosaves" value={stats.autosaves} note="Kept to the newest 20" />
        </StatCell>
        <StatCell>
          <Stat
            label="Oldest"
            value={stats.firstAt ? formatDate(stats.firstAt, context, 'short') : '—'}
            note={stats.lastAt ? `newest ${formatRelative(stats.lastAt, context)}` : undefined}
          />
        </StatCell>
      </StatRow>

      {revisions.length === 0 ? (
        <Section title="History">
          <InlineNote>
            Nothing has been recorded for this document yet. A revision is created by the first save
            or publish through the admin, and by the importer at the moment it first writes a file —
            a document the admin has never written has no history to show.
          </InlineNote>
        </Section>
      ) : (
        <Section title="History" description="Newest first.">
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Revision history for {title}, newest first. Each row links to the revision viewer.
              </caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    #
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Summary
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    By
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium text-ink-muted">
                    Change
                  </th>
                  <th scope="col" className="py-2 text-right font-medium text-ink-muted">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => {
                  const autosave = revision.summary === AUTOSAVE_SUMMARY
                  return (
                    <tr key={revision.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-3 tabular-nums text-ink-subtle">
                        {revision.revisionNo}
                      </td>
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <Link
                          href={`/admin/${segment}/${document.slug}/revisions/${revision.id}`}
                          className="text-ink hover:text-brand"
                        >
                          {revision.title}
                        </Link>
                        <span className="mt-0.5 block">
                          {autosave ? (
                            <Badge variant="outline">autosave</Badge>
                          ) : (
                            <span className="text-xs text-ink-muted">{revision.summary}</span>
                          )}
                        </span>
                      </th>
                      <td className="py-2 pr-3 text-ink-muted">
                        <time dateTime={revision.createdAt.toISOString()}>
                          {formatDate(revision.createdAt, context)}
                        </time>
                        <span className="mt-0.5 block text-xs text-ink-subtle">
                          {formatRelative(revision.createdAt, context)}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">
                        {revision.authorId
                          ? (authors.get(revision.authorId) ?? 'a deleted account')
                          : 'command line'}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {autosave ? (
                          // An autosave stores the buffer as its snapshot, so it
                          // has no previous state to diff against and no stats.
                          // Printing "+0 −0" would read as "no changes made",
                          // which is the opposite of true.
                          <span className="text-xs text-ink-subtle">snapshot of the buffer</span>
                        ) : (
                          <>
                            <span className="text-success">+{revision.additions}</span>{' '}
                            <span className="text-danger">−{revision.deletions}</span>
                          </>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-muted">
                        {formatBytes(revision.byteSize)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {total > revisions.length ? (
            <p className="mt-4 text-sm">
              <Link
                href={`/admin/${segment}/${document.slug}/revisions?limit=${Math.min(limit * 2, 200)}`}
                className="text-brand underline underline-offset-2"
              >
                Show more ({total - revisions.length} older)
              </Link>
            </p>
          ) : null}
        </Section>
      )}
    </Page>
  )
}

function clampLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_REVISION_LIMIT)
  if (!Number.isFinite(parsed)) return DEFAULT_REVISION_LIMIT
  return Math.min(Math.max(Math.trunc(parsed), 1), 200)
}

