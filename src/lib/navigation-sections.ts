/**
 * The left rail of the article layout.
 *
 * These are *sections of the site*, not links from the database, and the
 * distinction is why this is a function rather than a `getNavLinks('header')`
 * call. The header's navigation is content the owner edits from the admin and
 * can be anything at all; the article rail is a fixed map of the three content
 * types plus the archive, so a reader always knows where they are and always
 * has the same way out. Editing the header must not be able to empty it.
 *
 * A plain data function, deliberately: importing the navigation module here
 * would make every article page depend on a database read that the layout has
 * already done, and would put an editable surface in a place that is supposed
 * to be stable.
 */

export interface SectionLink {
  label: string
  href: string
  /** Set when the reader is inside this section. */
  current?: boolean
}

const SECTIONS = [
  { label: 'Writing', href: '/posts' },
  { label: 'Notes', href: '/notes' },
  { label: 'Projects', href: '/projects' },
  { label: 'Archive', href: '/archive' },
  { label: 'Tags', href: '/tags' },
  { label: 'Graph', href: '/graph' },
] as const

/**
 * The rail, with `current` set on the given section.
 *
 * `active` is compared against the section's own href rather than derived from
 * the current pathname, because the caller knows which section it is rendering
 * — an article at `/posts/foo` is in Writing, and nothing about that path would
 * tell a generic comparator so.
 */
export function sectionNavigation(active: string): SectionLink[] {
  return SECTIONS.map((section) => ({
    label: section.label,
    href: section.href,
    ...(section.href === active ? { current: true } : {}),
  }))
}
