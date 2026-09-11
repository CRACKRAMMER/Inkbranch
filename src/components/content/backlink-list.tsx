import Link from 'next/link'

import type { Backlink } from '@/lib/graph/backlinks'

/**
 * "Referenced by" — the documents that link here.
 *
 * This is the feature that makes a set of files a garden rather than a
 * chronological feed: it shows a note being used, not just published. It is
 * also the part most likely to be silently wrong, which is why `syncLinks`
 * stores `resolved` from the same predicate it counts with.
 *
 * Each entry lists the link text the author actually wrote. A document may
 * reference this one several times under different labels, and collapsing them
 * to one hides the context that makes the backlink worth showing.
 */
export function BacklinkList({ backlinks }: { backlinks: Backlink[] }) {
  if (backlinks.length === 0) return null

  return (
    <ul className="divide-y divide-line border-t border-line">
      {backlinks.map((link) => (
        <li key={link.id} className="py-3">
          <Link
            href={link.url}
            className="text-[0.9375rem] text-ink transition-colors duration-150 hover:text-brand"
          >
            {link.title}
          </Link>

          {link.references.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {link.references.map((reference, index) => (
                <li
                  key={`${reference.kind}:${reference.href}:${index}`}
                  className="font-mono text-[0.6875rem] text-ink-subtle"
                >
                  {reference.label ?? reference.href}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
