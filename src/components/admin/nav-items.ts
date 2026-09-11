/**
 * The admin's navigation, in one place because three surfaces render it: the
 * desktop sidebar, the mobile sheet, and the dashboard's own link cards.
 *
 * `matches` exists because several pages own a subtree (`/admin/posts/new`,
 * `/admin/posts/<slug>/edit`), and an item that is current only on its exact
 * path is a navigation that lies about where you are.
 */
export interface AdminNavItem {
  href: string
  label: string
  /** Shown in the mobile sheet and on the dashboard, not in the sidebar. */
  description: string
}

export interface AdminNavGroup {
  label: string
  items: AdminNavItem[]
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: 'Content',
    items: [
      {
        href: '/admin',
        label: 'Overview',
        description: 'Counts, recent edits and the state of the index',
      },
      {
        href: '/admin/posts',
        label: 'Posts',
        description: 'Long-form articles',
      },
      {
        href: '/admin/notes',
        label: 'Notes',
        description: 'Short entries and links',
      },
      {
        href: '/admin/projects',
        label: 'Projects',
        description: 'Portfolio entries with repository and stack',
      },
      {
        href: '/admin/assets',
        label: 'Assets',
        description: 'Uploaded images and files',
      },
      {
        href: '/admin/tags',
        label: 'Tags',
        description: 'Rename, merge and delete tags across documents',
      },
      {
        href: '/admin/import',
        label: 'Import',
        description: 'Bring in Markdown from an archive or a directory',
      },
    ],
  },
  {
    label: 'Site',
    items: [
      { href: '/admin/navigation', label: 'Navigation', description: 'Header, footer and social menus' },
      { href: '/admin/redirects', label: 'Redirects', description: 'Moved URLs and CSV import' },
      { href: '/admin/analytics', label: 'Analytics', description: 'Aggregate, cookie-less view counts' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/settings', label: 'Settings', description: 'Identity, SEO, features, revisions' },
      { href: '/admin/system', label: 'System', description: 'Sync, jobs, audit log and environment' },
    ],
  },
]

/** True when `pathname` is inside the item's subtree. */
export function isCurrent(item: AdminNavItem, pathname: string): boolean {
  if (item.href === '/admin') return pathname === '/admin'
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
