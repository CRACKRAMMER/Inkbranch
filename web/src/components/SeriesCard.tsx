import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, ChevronRight, Layers } from 'lucide-react'
import type { SeriesNav } from '../lib/types'

interface SeriesCardProps {
  seriesNav: SeriesNav
}

function seriesItemRoute(type: string, slug: string) {
  if (type === 'note') return { to: '/notes/$slug' as const, params: { slug } }
  if (type === 'project') return { to: '/projects/$slug' as const, params: { slug } }
  return { to: '/posts/$slug' as const, params: { slug } }
}

export function SeriesCard({ seriesNav }: SeriesCardProps) {
  const [expanded, setExpanded] = useState(false)
  const currentPos = Math.max(1, seriesNav.currentIndex + 1)
  const pct = Math.min(100, Math.round((currentPos / Math.max(1, seriesNav.total)) * 100))

  return (
    <section
      aria-label={`系列专栏 ${seriesNav.name}`}
      className="my-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"
          >
            <Layers className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <Link
              to="/series/$series"
              params={{ series: seriesNav.slug }}
              className="text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)]"
            >
              {seriesNav.name}
            </Link>
            <p className="text-xs text-[var(--text-muted)]">
              第 {currentPos} / {seriesNav.total} 篇 · 完成度 {pct}%
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <span>{expanded ? '收起目录' : '展开全部章节'}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {expanded ? (
        <ol className="mt-4 space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          {seriesNav.items.map((item, idx) => {
            const isCurrent = idx === seriesNav.currentIndex
            const route = seriesItemRoute(item.type, item.slug)
            return (
              <li key={`${item.type}:${item.slug}`}>
                <Link
                  to={route.to}
                  params={route.params}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                    isCurrent
                      ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span className="truncate">
                    <span className="mr-2 font-mono text-xs opacity-70">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {item.readingMinutes}m
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      ) : null}

      {seriesNav.prev || seriesNav.next ? (
        <div className="mt-3 grid grid-cols-1 gap-2 border-t border-[var(--border-subtle)] pt-3 sm:grid-cols-2">
          <div>
            {seriesNav.prev ? (
              <Link
                {...seriesItemRoute(seriesNav.prev.type, seriesNav.prev.slug)}
                className="group flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]"
              >
                <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">上一篇：{seriesNav.prev.title}</span>
              </Link>
            ) : null}
          </div>
          <div className="sm:text-right">
            {seriesNav.next ? (
              <Link
                {...seriesItemRoute(seriesNav.next.type, seriesNav.next.slug)}
                className="group inline-flex max-w-full items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]"
              >
                <span className="truncate">下一篇：{seriesNav.next.title}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
