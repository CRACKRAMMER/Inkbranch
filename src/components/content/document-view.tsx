import Link from 'next/link'

import { ArticleBody } from './article-body'
import { BacklinkList } from './backlink-list'
import { DocumentMeta } from './document-meta'
import { DocumentShell } from './document-shell'
import { PrevNext } from './prev-next'
import { RelatedList } from './related-list'
import { TableOfContentsDrawer } from './table-of-contents'
import type { ContentDetail, ContentSummary } from '@/lib/content/queries'
import { shouldShowToc, type Heading } from '@/lib/content/derive'
import type { Backlink } from '@/lib/graph/backlinks'
import type { RelatedPost } from '@/lib/graph/related'
import { sectionNavigation } from '@/lib/navigation-sections'
import type { Settings } from '@/lib/settings'
import { formatDate } from '@/lib/utils/date'

/**
 * The article page, shared by all three content types.
 *
 * Posts, notes and projects differ in their *header* — a project shows its
 * status, stack and repository links; a note shows the date it was planted and
 * the date it was last tended — and in nothing else. The body, the table of
 * contents, the reading progress, the related list, the backlinks and the
 * pagination are identical, so they live here and the three pages pass a
 * `headerExtra` slot rather than each maintaining their own copy of a
 * seven-hundred-line layout.
 *
 * `document` is the rendered HTML and arrives already rendered, because
 * rendering is async and this component is not.
 */

export interface DocumentViewProps {
  doc: ContentDetail
  html: string
  /** Rendered by the caller, inside the header, under the metadata line. */
  headerExtra?: React.ReactNode
  related: RelatedPost[]
  backlinks: Backlink[]
  adjacent: { newer: ContentSummary | null; older: ContentSummary | null }
  settings: Settings
  /** The section this document belongs to, for the left rail. */
  section: string
}

export function DocumentView({
  doc,
  html,
  headerExtra,
  related,
  backlinks,
  adjacent,
  settings,
  section,
}: DocumentViewProps) {
  const context = { locale: settings.locale, timeZone: settings.timezone }
  const headings = doc.headings as Heading[]

  return (
    <DocumentShell
      headings={headings}
      tocEnabled={doc.toc}
      sections={sectionNavigation(section)}
      sectionLabel="Sections"
      after={
        <div className="mt-16 flex flex-col gap-12">
          {related.length > 0 ? (
            <section aria-labelledby="related-heading">
              <h2
                id="related-heading"
                className="mb-3 font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle"
              >
                Related
              </h2>
              <RelatedList posts={related} {...context} />
            </section>
          ) : null}

          {backlinks.length > 0 ? (
            <section aria-labelledby="backlinks-heading">
              <h2
                id="backlinks-heading"
                className="mb-3 font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle"
              >
                Referenced by
              </h2>
              <BacklinkList backlinks={backlinks} />
            </section>
          ) : null}

          <PrevNext newer={adjacent.newer} older={adjacent.older} />
        </div>
      }
    >
      <article>
        <header className="mb-10 border-b border-line pb-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="min-w-0 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[2rem]">
              {doc.title}
            </h1>

            {/*
              Beside the title, where a reader looks for it — and only where the
              rail is not rendered. The two are one control: at no width should
              both be on screen, and at no width should neither be.
            */}
            {shouldShowToc(doc.toc, headings) ? (
              <div className="pt-1.5">
                <TableOfContentsDrawer headings={headings} />
              </div>
            ) : null}
          </div>

          {doc.description ? (
            <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-muted">
              {doc.description}
            </p>
          ) : null}

          <div className="mt-5">
            <DocumentMeta
              publishedAt={doc.publishedAt}
              updatedAt={doc.updatedAt}
              readingTime={doc.readingTime}
              tags={doc.tags}
              category={doc.category}
              {...context}
            />
          </div>

          {headerExtra}
        </header>

        <ArticleBody html={html} contentKey={doc.checksum} />

        {doc.series ? (
          <p className="mt-10 border-t border-line pt-4 text-[0.8125rem] text-ink-muted">
            Part of{' '}
            <Link
              href={`/series/${encodeURIComponent(doc.series)}`}
              className="text-brand hover:underline"
            >
              {doc.series}
            </Link>
          </p>
        ) : null}
      </article>
    </DocumentShell>
  )
}

/**
 * The definition list a project page shows under its title.
 *
 * A `<dl>` rather than a row of chips: these are labelled facts about an
 * artifact — when work started, what it is built from, where the code lives —
 * and a screen reader announces a definition list as pairs, which is exactly
 * what they are.
 */
export function DocumentFacts({
  facts,
}: {
  facts: { label: string; value: React.ReactNode }[]
}) {
  const shown = facts.filter((fact) => fact.value !== null && fact.value !== undefined)
  if (shown.length === 0) return null

  return (
    <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-t border-line pt-5 text-[0.8125rem]">
      {shown.map((fact) => (
        <div key={fact.label} className="col-span-2 grid grid-cols-subgrid">
          <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
            {fact.label}
          </dt>
          <dd className="text-ink-muted">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** `Started 14 Sep 2025`, or nothing when the date is absent. */
export function startedLabel(
  startedAt: string | null,
  locale: string,
  timeZone: string,
): string | null {
  if (!startedAt) return null
  return formatDate(startedAt, { locale, timeZone }, 'medium')
}
