import { cn } from '@/lib/utils/cn'

/**
 * The frame every admin page shares: a title, an optional line of explanation,
 * an optional action, and a measure.
 *
 * The measure is a prop rather than a constant because the three kinds of page
 * here genuinely differ. `prose` is the reading measure the brief asks for
 * (46rem = 736px); `wide` is for tables of documents, which are scanned rather
 * than read; `full` is only for the editor, which is a text field and a preview
 * side by side and needs the whole column.
 */
const MEASURES = {
  prose: 'max-w-[46rem]',
  wide: 'max-w-[68rem]',
  full: 'max-w-none',
} as const

export type PageMeasure = keyof typeof MEASURES

export function Page({
  title,
  description,
  actions,
  eyebrow,
  measure = 'wide',
  className,
  children,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  eyebrow?: string
  measure?: PageMeasure
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('mx-auto w-full', MEASURES[measure], className)}>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="mt-1 font-serif text-2xl tracking-tight text-ink">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-[36rem] text-sm leading-relaxed text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}

/**
 * A titled block inside a page. The heading is a real heading, not a label, so
 * the page has an outline a screen reader can jump through.
 */
export function Section({
  title,
  description,
  actions,
  level = 2,
  className,
  children,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  level?: 2 | 3
  className?: string
  children: React.ReactNode
}) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section className={cn('mt-10 first:mt-0', className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Heading
            className={cn(
              'text-ink',
              level === 2 ? 'text-sm font-medium tracking-tight' : 'text-xs font-medium',
            )}
          >
            {title}
          </Heading>
          {description ? (
            <p className="mt-1 max-w-[36rem] text-xs leading-relaxed text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * A number with a label, for the figures a page leads with.
 *
 * No card, no border of its own: the group these sit in supplies one rule
 * between each figure, which is quieter than four boxes and reads as a row of
 * measurements rather than four separate objects.
 */
export function Stat({
  label,
  value,
  note,
  className,
}: {
  label: string
  value: React.ReactNode
  note?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
        {label}
      </dt>
      <dd className="mt-2">
        <span className="font-serif text-2xl tracking-tight text-ink tabular-nums">{value}</span>
        {note ? <span className="mt-1 block text-xs text-ink-muted">{note}</span> : null}
      </dd>
    </div>
  )
}

/** A row of `Stat`s, divided by rules rather than boxed. */
export function StatRow({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <dl
      className={cn(
        'mt-6 grid grid-cols-2 gap-px overflow-hidden border border-line bg-line first:mt-0 sm:grid-cols-4',
        className,
      )}
    >
      {children}
    </dl>
  )
}

/** One cell of a `StatRow`; `Stat` fills it. */
export function StatCell({ children }: { children: React.ReactNode }) {
  return <div className="bg-surface px-4 py-4">{children}</div>
}

/**
 * The line a page shows when it has nothing to show yet.
 *
 * Deliberately not the `EmptyState` component: that one is centred and padded
 * for a large area, and half the empty states in the admin are one row of a
 * table ("no redirects yet").
 */
export function InlineNote({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'warning' | 'danger'
  className?: string
}) {
  return (
    <p
      className={cn(
        'mt-4 border px-4 py-3 text-sm leading-relaxed first:mt-0',
        tone === 'neutral' && 'border-line bg-sunken text-ink-muted',
        tone === 'warning' && 'border-warning/40 bg-warning/5 text-ink',
        tone === 'danger' && 'border-danger/40 bg-danger/5 text-ink',
        className,
      )}
    >
      {children}
    </p>
  )
}
