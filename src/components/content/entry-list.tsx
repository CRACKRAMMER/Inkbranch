import Link from 'next/link'

import { cn } from '@/lib/utils/cn'

import { TagList } from './tag-list'

/**
 * A dated row in a list of writing.
 *
 * One component serves the home timeline, the section indexes, the tag pages
 * and the archive, because all four are the same object: a date, a title, and
 * optionally more. Separate components per page would differ only in which
 * fields they pass, and would drift the moment one page changed its spacing.
 *
 * The date sits in a fixed-width left gutter so the titles below it align into
 * a single column. Left to flow, a list of dates ranging from "Sep 11" to
 * "11 September 2026" produces a ragged left edge on the thing the eye is
 * actually scanning.
 */
export interface Entry {
  href: string
  title: string
  /** Display form, e.g. "Sep 11". Pre-formatted on the server. */
  dateLabel: string
  /** Machine form for `<time datetime>`. */
  dateTime: string
  description?: string | null
  readingTime?: number
  tags?: { name: string; slug: string; color?: string | null }[]
  /** Shown before the title, for lists that mix content types. */
  typeLabel?: string
}

export function EntryList({
  entries,
  className,
  showDescription = false,
  showTags = false,
  showReadingTime = false,
}: {
  entries: Entry[]
  className?: string
  showDescription?: boolean
  showTags?: boolean
  showReadingTime?: boolean
}) {
  if (entries.length === 0) return null

  return (
    <ul className={cn('flex flex-col', className)}>
      {entries.map((entry) => (
        <li
          key={entry.href}
          className="entry-row group grid grid-cols-[4.5rem_1fr] items-baseline gap-x-4 border-b border-line py-3.5 last:border-b-0 sm:grid-cols-[5.5rem_1fr]"
        >
          <time dateTime={entry.dateTime} className="entry-row__date">
            {entry.dateLabel}
          </time>

          <div className="min-w-0">
            <Link href={entry.href} className="entry-row__title">
              {entry.typeLabel ? (
                <span className="mr-2 text-xs uppercase tracking-wider text-ink-subtle">
                  {entry.typeLabel}
                </span>
              ) : null}
              {entry.title}
            </Link>

            {showDescription && entry.description ? (
              <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
                {entry.description}
              </p>
            ) : null}

            {showReadingTime && entry.readingTime ? (
              <p className="mt-1 text-xs text-ink-subtle">{entry.readingTime} min read</p>
            ) : null}

            {showTags && entry.tags && entry.tags.length > 0 ? (
              <TagList tags={entry.tags} className="mt-2" />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
