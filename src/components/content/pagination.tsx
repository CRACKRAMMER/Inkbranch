import Link from 'next/link'

import { cn } from '@/lib/utils/cn'

/**
 * Previous/next navigation between pages of a list.
 *
 * Two links and a position, not a row of numbered buttons. A personal site
 * rarely has more than a handful of pages, and the numbers are the least
 * useful part of them — a reader moves one step at a time or jumps to the
 * beginning, and neither needs page 4 spelled out.
 *
 * `rel="prev"` and `rel="next"` are set because a crawler reads them as the
 * relationship between the paginated URLs, which is exactly what they are.
 * When there is no page to link to, the link is replaced by a disabled span
 * rather than removed, so the row does not reflow as a reader moves through it.
 */
export function Pagination({
  page,
  totalPages,
  hrefFor,
  className,
}: {
  page: number
  totalPages: number
  /**
   * Builds the href for a page. A function because the caller owns the other
   * query parameters — a filter that survives paging is a property of the
   * route, not of this component.
   */
  hrefFor: (page: number) => string
  className?: string
}) {
  if (totalPages <= 1) return null

  const hasPrevious = page > 1
  const hasNext = page < totalPages

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'mt-12 flex items-center justify-between gap-4 border-t border-line pt-5 text-sm',
        className,
      )}
    >
      {hasPrevious ? (
        <Link
          href={hrefFor(page - 1)}
          rel="prev"
          className="text-ink-muted transition-colors duration-150 hover:text-brand"
        >
          <span aria-hidden="true">← </span>
          Newer
        </Link>
      ) : (
        <span className="text-ink-subtle/60">
          <span aria-hidden="true">← </span>
          Newer
        </span>
      )}

      <span className="font-mono text-xs text-ink-subtle tabular-nums">
        {page} / {totalPages}
      </span>

      {hasNext ? (
        <Link
          href={hrefFor(page + 1)}
          rel="next"
          className="text-ink-muted transition-colors duration-150 hover:text-brand"
        >
          Older
          <span aria-hidden="true"> →</span>
        </Link>
      ) : (
        <span className="text-ink-subtle/60">
          Older
          <span aria-hidden="true"> →</span>
        </span>
      )}
    </nav>
  )
}
