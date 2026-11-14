import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ArrowUpRight, Layers } from 'lucide-react'
import { getSeriesDetail, listSeries } from '../lib/api'
import { collectionLabel, formatDateISO } from '../lib/format'
import { NotFoundPage } from './NotFoundPage'

export function SeriesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['series-list'],
    queryFn: listSeries,
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '系列专栏 Series — Inkbranch'
  }, [])

  const items = data?.items ?? []

  return (
    <div className="space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <Layers className="h-4 w-4" aria-hidden="true" />
          <span>Series · 体系化专题专栏</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          多篇连载系列与专题指南
        </h1>
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          按循序渐进的章节编排阅读长篇主题，当前共有 {items.length} 个活跃专题系列。
        </p>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="editorial-card h-44 animate-pulse" />
          <div className="editorial-card h-44 animate-pulse" />
        </div>
      ) : items.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          暂无系列专栏，可在文章 Frontmatter 添加 <code>series</code> 与 <code>seriesOrder</code> 字段创建。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {items.map((series) => (
            <article key={series.slug} className="editorial-card editorial-card-interactive p-6">
              <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 font-semibold text-[var(--accent)]">
                  {series.count} 篇连载
                </span>
                {series.latestAt ? (
                  <span>最近更新 {formatDateISO(series.latestAt)}</span>
                ) : null}
              </div>

              <h2 className="mt-3 text-xl font-bold text-[var(--text-primary)]">
                <Link
                  to="/series/$series"
                  params={{ series: series.slug }}
                  className="inline-flex items-center gap-1.5 hover:text-[var(--accent)]"
                >
                  <span>{series.name}</span>
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </h2>

              <ol className="mt-4 space-y-1.5 border-t border-[var(--border-subtle)] pt-3 text-sm">
                {series.items.slice(0, 4).map((entry, i) => (
                  <li key={`${entry.type}:${entry.slug}`}>
                    <Link
                      to={entry.url}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    >
                      <span className="truncate">
                        <span className="mr-2 font-mono text-xs text-[var(--text-muted)]">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        {entry.title}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--text-muted)]">
                        {entry.readingMinutes}m
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

export function SeriesDetailPage({ series }: { series: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['series-detail', series],
    queryFn: () => getSeriesDetail(series),
    staleTime: 60_000,
    retry: false,
  })

  useEffect(() => {
    if (data?.name) {
      document.title = `系列 · ${data.name} — Inkbranch`
    }
  }, [data])

  if (isLoading) {
    return <div className="editorial-card h-64 animate-pulse" />
  }

  if (isError || !data) {
    return <NotFoundPage />
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <Link
          to="/series"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>返回全部系列</span>
        </Link>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          {data.name}
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          共收录 {data.count} 篇内容，建议按顺序阅读。
        </p>
      </header>

      <ol className="space-y-3">
        {data.items.map((entry, idx) => (
          <li key={`${entry.type}:${entry.slug}`}>
            <Link
              to={entry.url}
              className="editorial-card editorial-card-interactive flex items-center justify-between gap-4 p-5"
            >
              <div className="flex items-center gap-4 min-w-0">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] font-mono text-sm font-bold text-[var(--accent)]">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <div className="text-xs text-[var(--text-muted)]">
                    {collectionLabel(entry.type)}
                  </div>
                  <div className="truncate text-base font-bold text-[var(--text-primary)]">
                    {entry.title}
                  </div>
                </div>
              </div>
              <span className="shrink-0 text-xs font-medium text-[var(--text-secondary)]">
                {entry.readingMinutes} 分钟阅读 →
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  )
}
