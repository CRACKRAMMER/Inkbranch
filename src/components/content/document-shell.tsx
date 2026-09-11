import Link from 'next/link'

import { TableOfContents } from './table-of-contents'
import { ReadingProgress } from '@/components/site/reading-progress'
import type { Heading } from '@/lib/content/derive'
import { MIN_HEADINGS_FOR_TOC, shouldShowToc } from '@/lib/content/derive'

/**
 * The three-column article layout: section navigation, the document, the table
 * of contents.
 *
 * The columns are not equal and are not meant to be. The middle column carries
 * the reading measure and the outer two are fixed-width rails that hold
 * secondary navigation. Both rails are `position: sticky`, so they stay
 * reachable while the article scrolls past, and both are hidden below `lg`,
 * where they would cost the measure its width.
 *
 * The contents list is the one rail that does not simply disappear when the
 * viewport narrows. Below `lg` the same list is a drawer hanging off a trigger
 * beside the title — rendered by `DocumentView`, which owns the header, rather
 * than here, which owns only the columns. Both are gated on the same
 * `shouldShowToc` rule, so a document that is too short for a contents list
 * does not get one at either width, and there is no width at which the reader
 * gets neither.
 */

export interface SectionLink {
  label: string
  href: string
  /** Shown when the reader is already inside this section. */
  current?: boolean
}

export function DocumentShell({
  children,
  after,
  headings,
  tocEnabled,
  sections,
  sectionLabel,
  className,
}: {
  /**
   * The document proper. Wrapped in `#article-body`, which the reading-progress
   * bar measures — so anything that is *about* the document rather than *of* it
   * belongs in `after`.
   */
  children: React.ReactNode
  /** Related documents, backlinks and pagination. Outside the progress measure. */
  after?: React.ReactNode
  headings: Heading[]
  /** Per-document `toc` frontmatter flag. */
  tocEnabled: boolean
  sections: SectionLink[]
  sectionLabel: string
  className?: string
}) {
  const showToc = shouldShowToc(tocEnabled, headings)

  return (
    <>
      <ReadingProgress targetId="article-body" />

      <div className={className}>
        <div className="mx-auto grid max-w-[84rem] gap-x-10 px-5 sm:px-8 lg:grid-cols-[11rem_minmax(0,1fr)_13rem]">
          {/* Left rail — section navigation */}
          <nav
            aria-label={sectionLabel}
            className="hidden lg:block lg:sticky lg:top-24 lg:self-start lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:py-12"
          >
            <ul className="flex flex-col gap-1">
              {sections.map((section) => (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    aria-current={section.current ? 'page' : undefined}
                    className="site-nav__link block py-1 text-[0.8125rem] text-ink-muted transition-colors duration-150 hover:text-ink"
                  >
                    {section.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* The document */}
          <div className="min-w-0 py-10 lg:py-12">
            <div id="article-body">{children}</div>
            {after}
          </div>

          {/* Right rail — table of contents */}
          <div className="hidden lg:block lg:sticky lg:top-24 lg:self-start lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:py-12">
            {showToc ? (
              <TableOfContents headings={headings} />
            ) : (
              /*
                An empty rail would be a column of nothing. Saying so is more
                useful than leaving it blank, and it explains the missing TOC
                rather than letting a reader assume it is broken.
              */
              headings.length > 0 && headings.length < MIN_HEADINGS_FOR_TOC ? (
                <p className="text-[0.75rem] leading-relaxed text-ink-subtle">
                  This document is short enough to read without a contents list.
                </p>
              ) : null
            )}
          </div>
        </div>
      </div>
    </>
  )
}
