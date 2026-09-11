/**
 * A stable hue for a tag.
 *
 * The brief asks for "lightweight visual identification" on topics, and a hue
 * is the cheapest honest form of it: a 6px dot beside the name, no background,
 * no border, no coloured text. Anything more turns a tag list into a colour
 * chart and fights the one-accent-colour rule the rest of the site follows.
 *
 * The hue is derived from the slug rather than assigned, so it is stable across
 * requests, deploys and machines without a column to store it, and it survives
 * a tag being renamed in name only. It is *not* meaningful — two unrelated tags
 * can land on neighbouring hues — which is why it is only ever a dot next to
 * the name and never the sole carrier of identity.
 *
 * Saturation and lightness are fixed by the CSS that consumes the hue, not
 * chosen here, so a derived hue and an admin-set hex colour land in the same
 * visual register.
 */
export function tagHue(slug: string): number {
  // FNV-1a. Chosen over a sum of char codes because that maps anagrams — and
  // any two slugs sharing a multiset of letters — to the same hue, which is
  // exactly the collision a reader would notice.
  let hash = 0x811c9dc5

  for (let index = 0; index < slug.length; index += 1) {
    hash ^= slug.charCodeAt(index)
    // `Math.imul` keeps the multiply in 32-bit range; `*` would go through a
    // double and lose the low bits that carry the entropy.
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0) % 360
}

/**
 * Whether an admin-supplied tag colour is safe to put in a `style` attribute.
 *
 * The column is validated on write, but it is rendered inside a `style`
 * attribute on a public page, so this is checked again at the point of use.
 * A value that reached the database before the validator existed — or through a
 * direct SQL import, which the content importer makes easy — would otherwise be
 * an injection point. Hex only: `rgb()`, `var()` and named colours are refused
 * because CSS permits `expression()`-adjacent constructs in older engines and
 * because the column is documented as a hex colour.
 */
export function safeTagColor(color: string | null | undefined): string | null {
  if (!color) return null
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.trim())
    ? color.trim()
    : null
}
