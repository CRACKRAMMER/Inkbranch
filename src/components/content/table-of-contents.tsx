'use client'

import { useEffect, useState } from 'react'

import type { Heading } from '@/lib/content/derive'
import { cn } from '@/lib/utils/cn'

/**
 * How long a jump is allowed to keep animating before the root stops asking for
 * smooth scrolling. The browser picks the real duration; this is only a ceiling
 * for readers whose browser never fires `scrollend`.
 */
const SMOOTH_JUMP_MS = 1000

/**
 * Jump to a heading, smoothly, without taking the browser's job away from it.
 *
 * The obvious implementation of "click the contents and glide there" is
 * `scroll-behavior: smooth` on `html`, and it is the wrong one here: the
 * property applies to *every* scroll of the viewport, including the ones nobody
 * asked to be slowed down. Next's router calls `scrollIntoView()` when a
 * navigation lands the reader on a page that is not under their current scroll
 * position, so a global rule would animate the jump to the top of every article
 * they open from halfway down the last one.
 *
 * So the property is set on the root for the length of one anchor navigation
 * and then taken back off. The click itself is not prevented, which is the
 * point: the browser still writes the `#fragment` into the URL, still pushes a
 * history entry, still moves the focus order to the target, and still honours
 * the heading's `scroll-margin-top`. All that changes is that the scroll to it
 * is animated — and only for readers who have not asked for less motion.
 */
function smoothJump(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  // Leave modified clicks alone: ⌘-click opens a new tab, and a click the code
  // inside the heading already handled is not ours to animate.
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return
  if (!document.getElementById(id)) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const root = document.documentElement
  root.style.scrollBehavior = 'smooth'

  // `scrollend` is the accurate signal but is not in every browser; the timer
  // is the floor beneath it. Clearing early costs nothing worse than the jump
  // finishing instantly, which is where it was going anyway. Both paths remove
  // the listener, so a leftover one cannot silence a later jump by firing on an
  // unrelated scroll.
  const done = () => {
    root.style.removeProperty('scroll-behavior')
    clearTimeout(timer)
    document.removeEventListener('scrollend', done)
  }
  const timer = setTimeout(done, SMOOTH_JUMP_MS)
  document.addEventListener('scrollend', done)
}

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
          onClick={(event) => {
            // The highlight is set here rather than waiting for the observer to
            // see the new position: with an animated scroll that would be a
            // second of the old section still marked as current.
            setActiveId(heading.id)
            smoothJump(event, heading.id)
          }}
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
 *
 * There is no scroll-spy here. The highlight answers "where am I in this
 * document", and on a phone the answer the reader wants is on the progress bar
 * they are already looking at; a highlight they would have to reopen the
 * disclosure to see is not an answer to anything.
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
          <a
            key={heading.id}
            href={`#${heading.id}`}
            data-depth={heading.level}
            // Deliberately left open after a jump: the list is in the flow
            // rather than over the article, so it scrolls away on its own, and
            // a reader working through several sections should not have to
            // reopen it between each one.
            onClick={(event) => smoothJump(event, heading.id)}
            className="toc-link"
          >
            {heading.text}
          </a>
        ))}
      </nav>
    </details>
  )
}
