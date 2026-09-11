import Link from 'next/link'

import { ThemeToggle } from '@/components/theme-toggle'

import { CommandPalette } from './command-palette'
import { MobileNav } from './mobile-nav'
import { SiteNav } from './site-nav'
import type { SiteLink } from './nav-link'

/**
 * The site header.
 *
 * A single hairline rule and a row of text. No shadow, no blur, no gradient —
 * the header sits on the same canvas as the page, and the border is what
 * separates them. `backdrop-blur` in particular is avoided: it costs a
 * compositing layer on every scroll and reads as decoration rather than
 * structure.
 *
 * It stays sticky because the search trigger and theme control are the two
 * things a reader reaches for mid-article, and scrolling back to the top to
 * find them is the tax you pay for a header that disappears.
 */
export function SiteHeader({
  siteName,
  homeHref = '/',
  links,
  searchEnabled,
}: {
  siteName: string
  homeHref?: string
  links: SiteLink[]
  searchEnabled: boolean
}) {
  return (
    <header className="no-print sticky top-0 z-40 border-b border-line bg-canvas">
      <div className="mx-auto flex h-14 w-full max-w-[76rem] items-center gap-4 px-5">
        <Link
          href={homeHref}
          className="shrink-0 text-[0.9375rem] font-medium tracking-tight text-ink transition-colors duration-150 hover:text-brand"
        >
          {siteName}
        </Link>

        <SiteNav links={links} className="ml-4 hidden md:flex" />

        <div className="ml-auto flex items-center gap-2">
          {searchEnabled ? <CommandPalette /> : null}
          <ThemeToggle className="hidden sm:inline-flex" />
          <MobileNav siteName={siteName} links={links} searchEnabled={searchEnabled} />
        </div>
      </div>
    </header>
  )
}
