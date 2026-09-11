import { safeTagColor, tagHue } from '@/lib/utils/tag-color'

/**
 * The tag identity dot.
 *
 * One component rather than the same six lines at each call site, because the
 * decision it encodes is not obvious: an admin-set colour is used when it is
 * valid, and a hue derived from the slug stands in when it is not. Two copies
 * of that would eventually disagree about what a tag with a malformed colour
 * looks like.
 *
 * It is `aria-hidden` everywhere it appears. The dot duplicates information
 * already carried by the tag's name, so announcing it would make a screen
 * reader say each tag twice.
 */
export function TagDot({ slug, color }: { slug: string; color?: string | null }) {
  const explicit = safeTagColor(color)

  return (
    <span
      aria-hidden="true"
      className="tag-dot"
      style={
        explicit
          ? // The helper has already confined this to a hex literal, so there
            // is nothing here that can escape the declaration.
            { backgroundColor: explicit }
          : // Custom properties are not in React's `CSSProperties`, because
            // React cannot know which ones exist. The cast is the documented
            // way to set one; the value is a number from a hash.
            ({ '--tag-hue': tagHue(slug) } as React.CSSProperties)
      }
    />
  )
}
