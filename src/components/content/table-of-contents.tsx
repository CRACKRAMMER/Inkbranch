'use client'

import { List } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
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
  title = 'On this page',
  onNavigate,
}: {
  headings: Heading[]
  className?: string
  /**
   * The list's own heading. `null` omits it, for the drawer, whose sheet title
   * already says what the list is — two headings a line apart is one heading
   * too many.
   */
  title?: string | null
  /** Called after a link is followed. The drawer closes itself with this. */
  onNavigate?: () => void
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
      {title ? (
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle">
          {title}
        </h2>
      ) : null}
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
            onNavigate?.()
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
 * The same contents as a bottom drawer, for the layouts without a rail.
 *
 * Shown below `xl`, which is where the rail stops being rendered — one
 * breakpoint rather than two, because the contents were previously a
 * `<details>` under `md` and a rail over `lg`, and the band between the two had
 * no contents list at all. A drawer covers every width the rail does not, so
 * there is no width at which a reader can see neither.
 *
 * The trigger sits beside the title, which is where a reader looks for it, and
 * the drawer is the phone-shaped version of the same list rather than a second
 * implementation of it: the component above, with its scroll-spy and its jump.
 *
 * Three details are about the jump surviving the drawer:
 *
 * - It is non-modal. A modal dialog locks the body scroll for as long as it is
 *   open, and the link the reader just tapped asks the browser to scroll the
 *   page — under the lock that scroll is discarded and the reader is left
 *   staring at the table of contents they asked to leave. Non-modal keeps the
 *   page scrollable, and the sheet closes while the jump is already running.
 * - There is no overlay, for the same reason: it would dim a page that is still
 *   live, and swallow the first tap outside.
 * - Focus is not returned to the trigger, which is what Radix does by default.
 *   The trigger is in the header, so refocusing it drags the viewport back up
 *   to where the reader started — undoing the jump they just made. The link
 *   took them somewhere; leaving the focus alone is what lets them stay there.
 *
 * It closes on selection for the obvious reason and for one more: the list is
 * over the article, so leaving it open would hide the section just arrived at.
 */
export function TableOfContentsDrawer({ headings }: { headings: Heading[] }) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetTrigger
        className="no-print inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[0.8125rem] text-ink-muted transition-colors duration-150 hover:bg-sunken hover:text-ink xl:hidden"
        aria-label={`Contents (${headings.length} sections)`}
      >
        <List className="size-3.5" aria-hidden="true" />
        Contents
      </SheetTrigger>

      <SheetContent
        side="bottom"
        overlay={false}
        className="no-print border-line bg-canvas xl:hidden"
        // See the note above: this is what keeps the jump from being undone.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle className="px-1 text-sm font-medium text-ink">Contents</SheetTitle>
        </SheetHeader>

        <TableOfContents
          headings={headings}
          title={null}
          onNavigate={() => setOpen(false)}
          className="pb-2"
        />
      </SheetContent>
    </Sheet>
  )
}
