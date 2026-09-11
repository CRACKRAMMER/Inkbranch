/**
 * The shape the site shell needs from a navigation row.
 *
 * Deliberately a separate, structural type rather than an import of `NavLink`
 * from `@/lib/navigation`. That module is marked `server-only` because it reads
 * the database, and although a type-only import is erased and would not
 * actually pull it into a client bundle, it is one careless value import away
 * from a build that fails for a reason nobody expects. The client shell should
 * not be able to name the server's module in the first place.
 *
 * The shell renders links and nothing else, so `id`, `position`, `visible` and
 * the timestamps are the query's business, not a header's.
 */
export interface SiteLink {
  label: string
  href: string
  external?: boolean
  /** Lucide icon name. Only the footer's social list uses this. */
  icon?: string | null
}

/**
 * Whether `href` should render as the current page for `pathname`.
 *
 * `/` matches only itself — every path starts with a slash, so a naive
 * `startsWith` would mark the home link active on every page in the site.
 * Everything else matches its own subtree, so `/posts` stays lit while reading
 * `/posts/a-slug`, which is what a reader expects from a section link.
 */
export function isActiveLink(pathname: string, href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? href
  if (path === '/' || path === '') return pathname === '/'
  return pathname === path || pathname.startsWith(`${path}/`)
}
