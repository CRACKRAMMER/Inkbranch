import Link from 'next/link'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * A titled region of a page.
 *
 * Every section on the site is the same shape — a small-caps eyebrow, an
 * optional link through to the full list, and content — so it is one component
 * rather than eight repetitions of the same three class strings. The eyebrow
 * is a real design decision (it is the only place small caps are used), and
 * having it in one place is what stops a ninth section from inventing its own
 * heading style.
 *
 * The heading is an `h2` because on every page that uses this, the `h1` is the
 * page title. A section that needs a different level can pass `as` — `/about`
 * does, because its sections sit under a name that is itself an `h2`.
 */
export function Section({
  as: Heading = 'h2',
  title,
  href,
  linkLabel = 'All',
  children,
  className,
  id,
}: {
  /** Heading level. Defaults to `h2`, which is right when the page title is the `h1`. */
  as?: 'h2' | 'h3'
  title: string
  /** When set, the heading gets a link through to the complete list. */
  href?: string
  linkLabel?: string
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={cn('mt-16', className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="mb-5 flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <Heading
          id={id ? `${id}-title` : undefined}
          className="text-xs font-medium uppercase tracking-wider text-ink-subtle"
        >
          {title}
        </Heading>
        {href ? (
          <Link
            href={href}
            className="shrink-0 text-xs text-ink-muted transition-colors duration-150 hover:text-brand"
          >
            {linkLabel}
            <span aria-hidden="true"> →</span>
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  )
}
