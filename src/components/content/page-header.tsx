import type { ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * The masthead of a list page.
 *
 * Every index on the site opens the same way — a title, a line saying what the
 * section is for, and a count — so it is one component. The count is not
 * decoration: on a list that is paginated or filtered, "9 notes" is how a
 * reader knows the list is complete rather than merely short.
 *
 * The rule under the header is a border rather than a heading background. It is
 * the same hairline that separates every other region on the site, which is
 * what makes the page read as one document instead of a stack of panels.
 */
export function PageHeader({
  title,
  description,
  meta,
  children,
  className,
}: {
  title: string
  description?: string | null
  /** The count line, or anything else that belongs under the description. */
  meta?: ReactNode
  /** Actions or filters, aligned to the end of the header on wide screens. */
  children?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('border-b border-line pb-6 pt-12 sm:pt-16', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-2xl tracking-tight text-ink sm:text-3xl">{title}</h1>

          {description ? (
            <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>

        {children ? <div className="shrink-0">{children}</div> : null}
      </div>

      {meta ? <div className="mt-4 text-xs text-ink-subtle">{meta}</div> : null}
    </header>
  )
}
