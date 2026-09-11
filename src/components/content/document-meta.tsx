import Link from 'next/link'

import { TagList } from './tag-list'
import type { TagRef } from '@/lib/content/queries'
import { formatDate, revisionNote } from '@/lib/utils/date'

/**
 * The line under an article's title.
 *
 * Dates are formatted on the server. `Intl` is large, and a client component
 * that formats dates renders one thing on the server and possibly another in
 * the browser — the classic hydration mismatch, and the reason timezone bugs
 * only appear for readers east of the author.
 */

export interface DocumentMetaProps {
  publishedAt: Date | null
  updatedAt: Date
  readingTime: number
  tags: TagRef[]
  category: string | null
  /** Site locale, so month names match the rest of the site. */
  locale: string
  timeZone: string
}

export function DocumentMeta({
  publishedAt,
  updatedAt,
  readingTime,
  tags,
  category,
  locale,
  timeZone,
}: DocumentMetaProps) {
  const context = { locale, timeZone }

  // "Updated 3 days ago" only when the edit is meaningful. A document saved
  // again during proofreading a minute after publishing is not an update, and
  // claiming it is trains readers to ignore the label.
  const revision = revisionNote(publishedAt, updatedAt, { ...context, now: new Date() })

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.8125rem] text-ink-muted">
      {publishedAt ? (
        <time dateTime={publishedAt.toISOString()} className="tabular-nums">
          {formatDate(publishedAt, context, 'medium')}
        </time>
      ) : (
        <span className="text-ink-subtle">Unpublished</span>
      )}

      <span aria-hidden="true" className="text-ink-subtle">
        ·
      </span>
      <span>{readingTime} min read</span>

      {revision ? (
        <>
          <span aria-hidden="true" className="text-ink-subtle">
            ·
          </span>
          <span className="text-brand">{revision}</span>
        </>
      ) : null}

      {category ? (
        <>
          <span aria-hidden="true" className="text-ink-subtle">
            ·
          </span>
          <Link
            href={`/tags/${encodeURIComponent(category.toLowerCase())}`}
            className="hover:text-ink"
          >
            {category}
          </Link>
        </>
      ) : null}

      {tags.length > 0 ? (
        <span className="w-full">
          <TagList tags={tags} />
        </span>
      ) : null}
    </div>
  )
}
