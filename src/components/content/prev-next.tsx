import Link from 'next/link'

import type { ContentSummary } from '@/lib/content/queries'

/**
 * The two documents either side of this one in publication order.
 *
 * A two-column grid that collapses to one column below `sm`, with the "newer"
 * link first in the DOM. On a phone the reading order therefore matches the
 * timeline order, and a keyboard user tabbing forward moves forward in time
 * rather than backwards.
 */
export function PrevNext({
  newer,
  older,
}: {
  newer: ContentSummary | null
  older: ContentSummary | null
}) {
  if (!newer && !older) return null

  return (
    <nav aria-label="Adjacent documents" className="grid gap-px border-t border-line sm:grid-cols-2">
      <div className="py-4 sm:pr-6">
        {newer ? (
          <Link href={newer.url} className="group block">
            <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
              Newer
            </span>
            <span className="mt-1 block text-[0.9375rem] text-ink transition-colors duration-150 group-hover:text-brand">
              {newer.title}
            </span>
          </Link>
        ) : null}
      </div>

      <div className="border-t border-line py-4 sm:border-l sm:border-t-0 sm:pl-6 sm:text-right">
        {older ? (
          <Link href={older.url} className="group block">
            <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
              Older
            </span>
            <span className="mt-1 block text-[0.9375rem] text-ink transition-colors duration-150 group-hover:text-brand">
              {older.title}
            </span>
          </Link>
        ) : null}
      </div>
    </nav>
  )
}
