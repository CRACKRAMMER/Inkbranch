import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Archive } from 'lucide-react'
import { getArchive } from '../lib/api'
import { collectionLabel, formatDateISO } from '../lib/format'

export function ArchivePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['archive'],
    queryFn: getArchive,
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '时间归档 Archive — Inkbranch'
  }, [])

  const years = data?.years ?? []

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <Archive className="h-4 w-4" aria-hidden="true" />
          <span>Chronological Archive</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          全站文章与随笔时间轴
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          按年份倒序归档全部公开发表内容，累计 {data?.total ?? 0} 篇作品。
        </p>
      </header>

      {isLoading ? (
        <div className="editorial-card h-64 animate-pulse" />
      ) : years.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          暂无归档条目
        </div>
      ) : (
        <div className="space-y-8">
          {years.map((group, idx) => (
            <section
              key={group.year}
              aria-labelledby={`archive-year-${group.year}`}
              className={idx >= 1 ? 'deferred-item space-y-3' : 'space-y-3'}
            >
              <div className="flex items-baseline gap-3">
                <h2
                  id={`archive-year-${group.year}`}
                  className="font-mono text-2xl font-bold text-[var(--text-primary)]"
                >
                  {group.year}
                </h2>
                <span className="text-xs text-[var(--text-muted)]">
                  {group.items.length} 篇
                </span>
              </div>

              <ul className="editorial-card divide-y divide-[var(--border-subtle)]">
                {group.items.map((item) => (
                  <li key={`${item.type}:${item.slug}`}>
                    <Link
                      to={item.url}
                      className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 transition-colors hover:bg-[var(--bg-elevated)]"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="shrink-0 rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                          {collectionLabel(item.type)}
                        </span>
                        <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {item.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                        {item.category ? <span>{item.category}</span> : null}
                        <time
                          dateTime={item.publishedAt || item.updatedAt}
                          className="font-mono"
                        >
                          {formatDateISO(item.publishedAt || item.updatedAt)}
                        </time>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
