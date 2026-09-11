'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils/cn'

import { isActiveLink, type SiteLink } from './nav-link'

/**
 * The desktop section nav.
 *
 * A client component only because active state needs `usePathname`. The links
 * themselves are plain `<Link>`s, so they prefetch and navigate like any other.
 *
 * Active state is carried by `aria-current="page"`, and the underline is drawn
 * from that attribute in CSS rather than from a class. Two sources of truth for
 * "is this the current page" is how a nav ends up visually active but silent to
 * a screen reader.
 */
export function SiteNav({ links, className }: { links: SiteLink[]; className?: string }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Sections" className={cn('flex items-center gap-1', className)}>
      {links.map((link) => (
        <Link
          key={`${link.href}:${link.label}`}
          href={link.href}
          aria-current={isActiveLink(pathname, link.href) ? 'page' : undefined}
          className="site-nav__link"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
