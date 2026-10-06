import Link from 'next/link'

import type { RelatedPost } from '@/lib/graph/related'
import { formatDate } from '@/lib/utils/date'

/**
 * Documents related to the one being read.
 *
 * Each entry says *why* it is here. `RelatedPost.signals` carries the individual
 * contributions to the score, and surfacing the strongest one turns a list of
 * links into a claim the reader can check — "shares #postgres" is verifiable at
 * a glance, where "related" is a black box. It is the same principle as a search
 * result showing the field its query matched.
 *
 * The algorithm is local and deterministic. Nothing here is generated, embedded
 * or inferred; two runs over the same corpus give the same list.
 */
export function RelatedList({
  posts,
  locale,
  timeZone,
}: {
  posts: RelatedPost[]
  locale: string
  timeZone: string
}) {
  if (posts.length === 0) return null

  return (
    <ul className="divide-y divide-line border-t border-line">
      {posts.map((post) => (
        <li key={post.id}>
          <Link
            href={post.url}
            className="group flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4"
          >
            <span className="min-w-0 flex-1 text-[0.9375rem] text-ink group-hover:text-brand">
              {post.title}
            </span>
            <span className="shrink-0 font-mono text-[0.6875rem] text-ink-subtle">
              {post.reason}
            </span>
            {post.publishedAt ? (
              <time
                dateTime={post.publishedAt.toISOString()}
                className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-ink-subtle"
              >
                {formatDate(post.publishedAt, { locale, timeZone }, 'short')}
              </time>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  )
}
