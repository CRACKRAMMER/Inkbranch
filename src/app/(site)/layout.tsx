import { SiteFooter } from '@/components/site/site-footer'
import { SiteHeader } from '@/components/site/site-header'
import type { SiteLink } from '@/components/site/nav-link'
import { getNavLinks } from '@/lib/navigation'
import { getSettings } from '@/lib/settings'

/**
 * The public shell.
 *
 * A route group rather than a path segment, so `/posts` is `/posts` and not
 * `/site/posts`. The admin lives in its own group with its own layout, which is
 * what lets it have a sidebar, no marketing header, and its own error boundary
 * without either shell knowing about the other.
 *
 * The three reads below are all `cache()`d per request, and each is cached
 * independently — a page that also needs the header's navigation does not
 * re-query it, because React's cache is keyed by function identity across the
 * whole render, not by component.
 *
 * Navigation rows are spread into the shell's `SiteLink` shape rather than
 * passed as `NavLink[]`. They are structurally compatible, but naming the
 * server type in a client component's props is how the client boundary gets
 * crossed by accident; the spread makes the conversion explicit and one-way.
 */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const [settings, header, footer, social] = await Promise.all([
    getSettings(),
    getNavLinks('header'),
    getNavLinks('footer'),
    getNavLinks('social'),
  ])

  const toSiteLinks = (links: typeof header): SiteLink[] =>
    links.map((link) => ({
      label: link.label,
      href: link.href,
      external: link.external,
      icon: link.icon,
    }))

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <SiteHeader
        siteName={settings.siteName}
        links={toSiteLinks(header)}
        searchEnabled={settings.searchEnabled}
      />

      {/*
        `#main` is the skip link's target. `tabIndex={-1}` is required for the
        browser to actually move focus here — without it the URL fragment
        changes and the keyboard user is still at the top of the document.
      */}
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>

      <SiteFooter
        siteName={settings.siteName}
        sections={toSiteLinks(footer)}
        social={toSiteLinks(social)}
        rssEnabled={settings.rssEnabled}
        colophon={settings.tagline || settings.siteDescription}
      />
    </div>
  )
}
