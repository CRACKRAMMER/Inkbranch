import Link from 'next/link'

import { isAbsoluteHref, isExternalWebHref } from '@/lib/utils/url'

import type { SiteLink } from './nav-link'

/**
 * One footer link.
 *
 * The element is chosen from the href rather than from which column it sits in,
 * because the columns are admin-editable and a `mailto:` in the social list is
 * entirely reasonable. `next/link` is for in-app routes; handing it an absolute
 * URL gets you a client-side navigation attempt at something that is not a
 * route. Conversely a site path rendered as a plain `<a>` loses prefetching.
 *
 * `rel="me"` is set on every link here: this is the footer, its links are the
 * author's identities elsewhere, and `rel="me"` is how a personal site proves
 * it owns the accounts it points at.
 */
function FooterLink({ link, className }: { link: SiteLink; className: string }) {
  const absolute = isAbsoluteHref(link.href)

  if (!absolute) {
    return (
      <Link href={link.href} rel="me" className={className}>
        {link.label}
      </Link>
    )
  }

  const opensNewTab = isExternalWebHref(link.href)

  return (
    <a
      href={link.href}
      rel={opensNewTab ? 'me noopener noreferrer' : 'me'}
      // Only real websites get a new tab. A `mailto:` with `target="_blank"`
      // launches the mail client and leaves an empty tab behind.
      {...(opensNewTab ? { target: '_blank' } : {})}
      className={className}
    >
      {link.label}
    </a>
  )
}

/**
 * The site footer.
 *
 * Three columns on a wide screen — identity, sections, elsewhere — collapsing
 * to a single stack on a phone. It carries what the header should not: the
 * secondary routes, the off-site links, and the feed, which is the one part of
 * the site a reader may want without visiting it.
 */
export function SiteFooter({
  siteName,
  sections,
  social,
  rssHref = '/rss.xml',
  rssEnabled,
  colophon,
}: {
  siteName: string
  sections: SiteLink[]
  social: SiteLink[]
  rssHref?: string
  rssEnabled: boolean
  colophon?: string
}) {
  const linkClass =
    'w-fit text-sm text-ink-muted transition-colors duration-150 hover:text-ink'

  return (
    <footer className="no-print mt-24 border-t border-line">
      <div className="mx-auto grid w-full max-w-[76rem] gap-10 px-5 py-12 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-3">
          <Link href="/" className="w-fit text-sm font-medium tracking-tight text-ink">
            {siteName}
          </Link>
          {colophon ? (
            <p className="measure text-sm leading-relaxed text-ink-subtle">{colophon}</p>
          ) : null}
        </div>

        <nav aria-label="Sections" className="flex flex-col gap-2.5">
          <h2 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
            Sections
          </h2>
          {sections.map((link) => (
            <FooterLink key={`${link.href}:${link.label}`} link={link} className={linkClass} />
          ))}
        </nav>

        <nav aria-label="Elsewhere" className="flex flex-col gap-2.5">
          <h2 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">Elsewhere</h2>
          {social.map((link) => (
            <FooterLink key={`${link.href}:${link.label}`} link={link} className={linkClass} />
          ))}
          {rssEnabled ? (
            <a href={rssHref} className={linkClass}>
              RSS
            </a>
          ) : null}
        </nav>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto w-full max-w-[76rem] px-5 py-5">
          <p className="text-xs text-ink-subtle">
            Written in Markdown. Rendered on the server.
          </p>
        </div>
      </div>
    </footer>
  )
}
