import Link from 'next/link'

import { cn } from '@/lib/utils/cn'

/**
 * Pagination as links, not buttons.
 *
 * A page of results is addressable, so it is a URL: the operator can bookmark
 * it, and the back button works. The current page is also rendered — a "next
 * only" control hides where you are in a long archive.
 */
export function Pagination({
  page,
  pageCount,
  total,
  hrefFor,
  noun = 'document',
  plural,
}: {
  page: number
  pageCount: number
  total: number
  hrefFor: (page: number) => string
  /** What is being counted, so the count line does not call an asset a document. */
  noun?: string
  /**
   * The same word for several of them, for the nouns where appending an `s`
   * writes a word nobody wrote — `entry` is the one that exists today, and the
   * count line read "12 entrys" until it was spelled out. `TYPE_GROUP_LABELS`
   * makes the same call for the content types, and gives the same reason.
   */
  plural?: string
}) {
  const counted = `${total} ${total === 1 ? noun : (plural ?? `${noun}s`)}`

  if (pageCount <= 1) {
    return <p className="text-xs tabular text-ink-subtle">{counted}</p>
  }

  const window = pageWindow(page, pageCount)

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1 text-sm">
      <PageLink href={hrefFor(page - 1)} disabled={page <= 1} label="Previous" />
      {window.map((entry, index) =>
        entry === null ? (
          <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-subtle">
            …
          </span>
        ) : (
          <Link
            key={entry}
            href={hrefFor(entry)}
            aria-current={entry === page ? 'page' : undefined}
            className={cn(
              'min-w-8 rounded-sm px-2 py-1 text-center tabular',
              entry === page
                ? 'bg-brand-quiet text-brand'
                : 'text-ink-muted hover:bg-sunken hover:text-ink',
            )}
          >
            {entry}
          </Link>
        ),
      )}
      <PageLink href={hrefFor(page + 1)} disabled={page >= pageCount} label="Next" />
      <span className="ml-2 text-xs tabular text-ink-subtle">{counted}</span>
    </nav>
  )
}

function PageLink({
  href,
  disabled,
  label,
}: {
  href: string
  disabled: boolean
  label: string
}) {
  if (disabled) {
    return (
      <span aria-disabled="true" className="px-2 py-1 text-ink-subtle opacity-60">
        {label}
      </span>
    )
  }
  return (
    <Link href={href} className="px-2 py-1 text-ink-muted hover:bg-sunken hover:text-ink">
      {label}
    </Link>
  )
}

/** `1 … 4 5 6 … 20` — first, last and a window around the current page. */
function pageWindow(page: number, pageCount: number): (number | null)[] {
  const pages = new Set<number>([1, pageCount, page - 1, page, page + 1])
  const sorted = [...pages].filter((entry) => entry >= 1 && entry <= pageCount).sort((a, b) => a - b)

  const out: (number | null)[] = []
  let previous = 0
  for (const entry of sorted) {
    if (previous && entry - previous > 1) out.push(null)
    out.push(entry)
    previous = entry
  }
  return out
}
