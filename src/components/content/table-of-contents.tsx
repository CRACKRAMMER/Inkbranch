'use client'

import { useEffect, useState } from 'react'

import type { Heading } from '@/lib/content/derive'
import { cn } from '@/lib/utils/cn'

/**
 * Table of contents with scroll-spy.
 *
 * The list is flat and indented by `data-depth`, not nested. Nesting costs an
 * extra tree walk and a recursive render, and it buys nothing here: the
 * indentation already reads as hierarchy, and a flat list makes "which heading
 * am I in" a simple scan instead of a tree traversal.
 *
 * The observation band is a strip near the top of the viewport rather than the
 * whole viewport. Watching the whole viewport means several headings are
 * "visible" at once and the highlight flickers between them; watching a strip
 * means exactly one is current, which is the question being asked.
 *
 * When nothing is in the strip — the reader is between headings — the previous
 * highlight is deliberately kept. Clearing it would blink the TOC off on every
 * scroll between sections, and the reader has not moved on to a new section.
 */
export function TableOfContents({
  headings,
  className,
}: {
  headings: Heading[]
  className?: string
}) {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    if (headings.length === 0) return

    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null)

    if (elements.length === 0) return

    const order = new Map(elements.map((element, index) => [element.id, index]))

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target.id)
          .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))

        // An empty batch is a heading leaving the band, not a section change.
        const next = visible[0]
        if (next) setActiveId(next)
      },
      {
        // Top inset clears the sticky header plus a line of breathing room;
        // the bottom inset keeps only the upper third of the viewport.
        rootMargin: '-88px 0px -66% 0px',
        threshold: 0,
      },
    )

    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [headings])

  return (
    <nav aria-label="On this page" className={cn('flex flex-col', className)}>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle">
        On this page
      </h2>
      {headings.map((heading) => (
        <a
          key={heading.id}
          href={`#${heading.id}`}
          data-depth={heading.level}
          // `location` rather than `page`: this marks where in the document the
          // reader is, not which document they are on.
          aria-current={activeId === heading.id ? 'location' : undefined}
          onClick={() => setActiveId(heading.id)}
          className="toc-link"
        >
          {heading.text}
        </a>
      ))}
    </nav>
  )
}

/**
 * The same contents as a disclosure, for the narrow layout.
 *
 * Native `<details>` rather than a controlled component: the browser already
 * knows how to expand, focus and announce it, and it works before hydration.
 * It is closed by default — on a phone the contents would otherwise push the
 * article below the fold, which is the opposite of what a reader wants.
 */
export function InlineTableOfContents({ headings }: { headings: Heading[] }) {
  return (
    <details className="no-print mb-10 border-y border-line py-3 md:hidden">
      <summary className="cursor-pointer list-none text-sm text-ink-muted marker:content-none">
        On this page
        <span className="ml-2 text-ink-subtle">({headings.length})</span>
      </summary>
      <nav aria-label="On this page" className="mt-3 flex flex-col">
        {headings.map((heading) => (
          <a key={heading.id} href={`#${heading.id}`} data-depth={heading.level} className="toc-link">
            {heading.text}
          </a>
        ))}
      </nav>
    </details>
  )
}
