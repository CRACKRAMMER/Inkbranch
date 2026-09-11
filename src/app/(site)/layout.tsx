import { SiteFooter } from '@/components/site/site-footer'
import { SiteHeader } from '@/components/site/site-header'
import type { SiteLink } from '@/components/site/nav-link'
import { getNavLinks } from '@/lib/navigation'
import { getSettings } from '@/lib/settings'

/**
 * Render the public tree per request, never at build time.
 *
 * ## Why the whole tree, and why this is not a performance decision
 *
 * Every page under this layout reads the content index. Next.js cannot see
 * that — reading a database looks like any other function call — so a page with
 * no dynamic API in it is classified as static, and its `revalidate` makes it
 * incremental: **prerendered during `next build`**.
 *
 * That produces two failures, and the second is the dangerous one.
 *
 * The build fails outright when no database is reachable, because prerendering
 * runs the queries. The production image is built that way on purpose — the
 * Dockerfile passes a placeholder `DATABASE_URL` — so the image could not be
 * built at all.
 *
 * And when a database *is* reachable, which is the case on any developer
 * machine, the build succeeds and silently **bakes that database's content into
 * the output**. The image would ship whatever the author had in their
 * development database at build time, frozen, and go on serving it after
 * publication. The content tree is a volume and the image is meant to be
 * byte-identical whatever is published with it; this is the exact opposite, and
 * it fails quietly.
 *
 * So the pages render on demand, which is what they always were in substance.
 * The cost is a handful of indexed queries against a local Postgres on each
 * request; the gain is that publishing a post is visible immediately, that the
 * build needs no database, and that the image cannot contain content.
 *
 * It also covers the changes that do not come through the admin at all — a file
 * dropped into `content/`, a `content:sync`, the worker flipping a scheduled
 * post to published. None of those call `revalidatePath`, and under a
 * time-based cache each one would have been invisible until the window elapsed.
 *
 * Freshness after a write is `revalidateContentChange` in
 * `src/lib/admin/revalidate.ts`, which invalidates the client-side router cache
 * for the affected paths. That still matters here: without it, a client-side
 * navigation back to a list page would serve the router's cached copy.
 *
 * The per-page `revalidate` exports this replaces are gone. They were inert
 * under `force-dynamic`, and a number that looks like it controls caching but
 * does not is worse than no number at all.
 *
 * A route group rather than a path segment, so `/posts` is `/posts` and not
 * `/site/posts`. The admin lives in its own group with its own layout, which is
 * what lets it have a sidebar, no marketing header, and its own error boundary
 * without either shell knowing about the other.
 *
 * The three reads below are all `cache()`d per request, and each is cached
 * independently — a page that also needs the header's navigation does not
 * re-query it, because React's cache is keyed by function identity across the
 * whole render, not by component. That is also what keeps `force-dynamic`
 * cheap: the shell's queries run once per request, not once per component.
 *
 * Navigation rows are spread into the shell's `SiteLink` shape rather than
 * passed as `NavLink[]`. They are structurally compatible, but naming the
 * server type in a client component's props is how the client boundary gets
 * crossed by accident; the spread makes the conversion explicit and one-way.
 */
export const dynamic = 'force-dynamic'

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
