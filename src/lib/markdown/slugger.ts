/**
 * GitHub-compatible heading slugs.
 *
 * The heading IDs emitted by the rehype plugin and the anchors stored in
 * `content_index.headings` must be produced by the *same* function, otherwise
 * the table of contents links to nowhere. Reimplementing GitHub's algorithm
 * here keeps that guarantee without pulling in `github-slugger`, and lets the
 * TOC be derived from raw Markdown without rendering it first.
 */

/**
 * Characters removed before slugging: Unicode punctuation, symbols, control
 * characters and format marks. Letters, digits, combining marks, underscore,
 * hyphen and space survive.
 */
const REMOVE = /[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu

export function slugifyHeading(value: string): string {
  return value.toLowerCase().replace(REMOVE, '').replace(/ /g, '-')
}

/**
 * Stateful slugger. Instances must be created per document so that duplicate
 * headings within one article get `-1`, `-2`, … suffixes.
 */
export class HeadingSlugger {
  private readonly seen = new Map<string, number>()

  /** Return a unique id for `value`, registering it for later collisions. */
  slug(value: string): string {
    const base = slugifyHeading(value)
    const count = this.seen.get(base)

    if (count === undefined) {
      this.seen.set(base, 0)
      return base
    }

    let next = count + 1
    let candidate = `${base}-${next}`
    // A generated suffix can itself collide with a literal heading name,
    // e.g. "# Foo" repeated plus an explicit "# Foo 1".
    while (this.seen.has(candidate)) {
      next += 1
      candidate = `${base}-${next}`
    }

    this.seen.set(base, next)
    this.seen.set(candidate, 0)
    return candidate
  }

  reset(): void {
    this.seen.clear()
  }
}
