import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import {
  RevisionCompareError,
  RevisionNotFoundError,
  compareRevisions,
  getRevision,
  listRevisions,
} from '@/lib/revision/store'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'
import { loadEditorDocument } from '@/lib/admin/documents'
import { revisionAuthors } from '@/lib/admin/revisions'
import { typeFromSegment } from '@/lib/admin/routes'
import { InlineNote, Page, Section } from '@/components/admin/page'
import { RestoreRevisionButton } from '@/components/admin/revision-restore'
import { RevisionDiff } from '@/components/admin/revision-diff'

export const metadata: Metadata = { title: 'Compare revisions' }

/**
 * Two revisions side by side, as a diff.
 *
 * The pair lives in the URL, so a diff is a thing you can link to. Whichever
 * revision is `from` is the one offered for restore, because that is the state
 * the reader selected first and is judging the change against.
 */
export default async function CompareRevisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; slug: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  await requireUser()

  const [{ type: segment, slug }, query] = await Promise.all([params, searchParams])
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const document = await loadEditorDocument(type, slug)
  if (!document || !document.contentId) notFound()

  const [siblings, settings] = await Promise.all([
    listRevisions(document.contentId, { limit: 200 }),
    getSettings(),
  ])

  const listHref = `/admin/${segment}/${document.slug}/revisions`
  const fallbackFrom = siblings[0]?.id
  const fallbackTo = siblings[1]?.id
  const from = query.from ?? fallbackFrom
  const to = query.to ?? fallbackTo

  if (!from || !to || siblings.length < 2) {
    return (
      <Page title="Compare revisions" eyebrow={document.values.title || document.derivedTitle}>
        <InlineNote>
          This document has fewer than two revisions, so there is nothing to compare.{' '}
          <Link href={listHref} className="text-brand underline underline-offset-2">
            Back to the history
          </Link>
          .
        </InlineNote>
      </Page>
    )
  }

  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }

  let comparison
  let failure: string | null = null
  try {
    comparison = await compareRevisions(from, to)
  } catch (error) {
    if (error instanceof RevisionCompareError) {
      failure = error.message
    } else if (error instanceof RevisionNotFoundError) {
      notFound()
    } else {
      throw error
    }
  }

  if (!comparison) {
    return (
      <Page title="Compare revisions" eyebrow={document.values.title || document.derivedTitle}>
        <InlineNote tone="warning">
          {failure ?? 'That pair of revisions cannot be compared.'}{' '}
          <Link href={listHref} className="text-brand underline underline-offset-2">
            Back to the history
          </Link>
          .
        </InlineNote>
      </Page>
    )
  }

  const [authors] = await Promise.all([
    revisionAuthors([comparison.from.authorId ?? '', comparison.to.authorId ?? '']),
  ])
  const describe = (revision: typeof comparison.from) =>
    `#${revision.revisionNo} · ${formatDate(revision.createdAt, context)} (${formatRelative(
      revision.createdAt,
      context,
    )})${revision.authorId ? ` · ${authors.get(revision.authorId) ?? 'deleted account'}` : ' · command line'}`

  return (
    <Page
      eyebrow={document.values.title || document.derivedTitle}
      title="Compare revisions"
      description={
        <>
          {describe(comparison.from)} → {describe(comparison.to)}. The diff reads from the first
          revision to the second.
        </>
      }
      actions={
        <>
          <Link href={listHref} className="text-sm text-ink-muted hover:text-brand">
            ← All revisions
          </Link>
          <RestoreRevisionButton
            revisionId={comparison.from.id}
            revisionNo={comparison.from.revisionNo}
            createdAt={formatDate(comparison.from.createdAt, context)}
            additions={comparison.from.additions}
            deletions={comparison.from.deletions}
            variant="secondary"
            label={`Restore #${comparison.from.revisionNo}`}
          />
        </>
      }
    >
      <Section
        title="Pick another pair"
        description="Either revision can be swapped; the page re-renders the diff."
      >
        <div className="flex flex-wrap gap-6">
          <RevisionPicker
            legend="From (older)"
            name="from"
            current={from}
            other={{ from, to }}
            options={siblings}
            action={`/admin/${segment}/${document.slug}/revisions/compare`}
            context={context}
          />
          <RevisionPicker
            legend="To (newer)"
            name="to"
            current={to}
            other={{ from, to }}
            options={siblings}
            action={`/admin/${segment}/${document.slug}/revisions/compare`}
            context={context}
          />
        </div>
      </Section>

      <Section title="Difference">
        <RevisionDiff diff={comparison.diff} />
      </Section>

      <Section
        title="Raw sizes"
        description="What the stored snapshots cost, which is the honest answer to whether the history is worth keeping."
      >
        <dl className="divide-y divide-line border-y border-line text-sm">
          {[comparison.from, comparison.to].map((revision) => (
            <div key={revision.id} className="flex flex-wrap gap-x-6 gap-y-1 py-2">
              <dt className="w-16 shrink-0 font-mono text-xs text-ink-muted">
                #{revision.revisionNo}
              </dt>
              <dd className="text-xs text-ink-muted">
                {formatBytes(revision.byteSize)} uncompressed · {revision.contentHash.slice(0, 12)} ·{' '}
                {revision.summary}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {comparison.diff.stats.additions === 0 && comparison.diff.stats.deletions === 0 ? (
        <InlineNote>
          These two revisions hold the same text. That happens when a save changed only the
          frontmatter beyond the fields the file serialises in a fixed order, or when a document was
          saved twice without an edit between them.
        </InlineNote>
      ) : null}
    </Page>
  )
}

/** One side of the pair: a GET form so the choice lives in the URL. */
function RevisionPicker({
  legend,
  name,
  current,
  other,
  options,
  action,
  context,
}: {
  legend: string
  name: 'from' | 'to'
  current: string
  other: { from: string; to: string }
  options: { id: string; revisionNo: number; summary: string; createdAt: Date }[]
  action: string
  context: { locale: string; timeZone: string; now: Date }
}) {
  return (
    <form method="get" action={action} className="min-w-0">
      <fieldset>
        <legend className="mb-1 text-xs text-ink-muted">{legend}</legend>
        <div className="flex items-end gap-2">
          <select
            name={name}
            defaultValue={current}
            className="h-9 max-w-[22rem] rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                #{option.revisionNo} · {option.summary} · {formatDate(option.createdAt, context)}
              </option>
            ))}
          </select>
          {/* The other half of the pair travels with this one. */}
          <input type="hidden" name={name === 'from' ? 'to' : 'from'} value={other[name === 'from' ? 'to' : 'from']} />
          <button
            type="submit"
            className="h-9 rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-sunken"
          >
            Use
          </button>
        </div>
      </fieldset>
    </form>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
