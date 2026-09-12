import Link from 'next/link'

import { cn } from '@/lib/utils/cn'

import { TagDot } from './tag-dot'

/**
 * A row of tag links.
 *
 * The dot carries the tag's identity — an admin-set colour when there is one,
 * a hue derived from the slug otherwise — and the name is always present as
 * text. That ordering matters: colour is decoration layered on top of a label
 * that already works, never the label itself, so the list is fully readable in
 * greyscale and to a screen reader.
 *
 * Tags here are plain text links rather than a bordered chip. Six pills in a
 * row is the visual language the brief rules out, and a chip that does nothing
 * but navigate is a link wearing a costume.
 */
export function TagList({
  tags,
  className,
  showHash = true,
}: {
  tags: { name: string; slug: string; color?: string | null }[]
  className?: string
  /** The leading `#`. Off in dense contexts where it reads as noise. */
  showHash?: boolean
}) {
  if (tags.length === 0) return null

  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
      {tags.map((tag) => (
        <li key={tag.slug} className="flex items-center gap-1.5">
          <TagDot slug={tag.slug} color={tag.color} />
          <Link
            href={`/tags/${encodeURIComponent(tag.slug)}`}
            // `text-xs` alone gives a 18px-tall box, which is under the 24px a
            // touch target needs — these are tapped with a thumb, not pointed at
            // with a cursor, and the row is dense enough that the miss is
            // habitual rather than occasional. `py-1` is the smallest step on
            // the spacing scale that clears 24px; it costs 8px of card height
            // and nothing else, since the box is transparent either way and
            // these are deliberately not chips.
            className="py-1 text-xs text-ink-muted transition-colors duration-150 hover:text-ink"
          >
            {showHash ? <span className="text-ink-subtle">#</span> : null}
            {tag.name}
          </Link>
        </li>
      ))}
    </ul>
  )
}
