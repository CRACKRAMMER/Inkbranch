'use client'

import { Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

import { ThemeToggle } from '@/components/theme-toggle'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils/cn'

import { isActiveLink, type SiteLink } from './nav-link'

/**
 * Phone navigation, as a bottom sheet.
 *
 * A bottom sheet rather than a hamburger drawer because it is where a thumb
 * already is, and because it is a genuinely different presentation: the links
 * are full-width rows with generous tap targets and the current page is stated
 * outright, which the horizontal desktop row cannot do at that width.
 *
 * It closes on navigation. Radix restores focus to the trigger, so a keyboard
 * user is returned to where they started rather than to the top of the page.
 */
export function MobileNav({
  siteName,
  links,
  searchEnabled,
}: {
  siteName: string
  links: SiteLink[]
  searchEnabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-sunken hover:text-ink md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-4" aria-hidden="true" />
      </SheetTrigger>

      <SheetContent side="bottom" className="border-line bg-canvas md:hidden">
        <SheetTitle className="px-1 text-sm font-medium text-ink">{siteName}</SheetTitle>

        <nav aria-label="Sections" className="flex flex-col">
          {links.map((link) => {
            const active = isActiveLink(pathname, link.href)

            return (
              <Link
                key={`${link.href}:${link.label}`}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                // Closed here rather than from an effect watching the pathname.
                // The effect fired for any pathname change, including ones this
                // nav did not cause, and closing on the click is both more
                // precise and a render earlier — the sheet is already gone
                // while the new page is still streaming in.
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center justify-between border-b border-line py-3.5 text-base transition-colors duration-150',
                  active ? 'text-ink' : 'text-ink-muted',
                )}
              >
                {link.label}
                {active ? (
                  <span className="text-xs text-ink-subtle" aria-hidden="true">
                    Current
                  </span>
                ) : null}
              </Link>
            )
          })}
        </nav>

        <div className="flex items-center justify-between px-1 pb-2 pt-1">
          <span className="text-xs uppercase tracking-wider text-ink-subtle">Theme</span>
          <ThemeToggle />
        </div>

        {searchEnabled ? (
          /*
           * A plain link to the search page rather than the palette: on a phone
           * the palette's keyboard-first model is the wrong one, and the search
           * page is a full-page form built for touch.
           */
          <Link
            href="/search"
            onClick={() => setOpen(false)}
            className="rounded-md border border-line px-3 py-2.5 text-center text-sm text-ink-muted transition-colors duration-150 hover:text-ink"
          >
            Search
          </Link>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
