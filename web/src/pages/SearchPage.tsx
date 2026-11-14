import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FileText, Search } from 'lucide-react'
import { searchContent } from '../lib/api'
import { collectionLabel, formatDateISO } from '../lib/format'
import type { ContentType } from '../lib/types'

export function SearchPage({ initialQuery = '' }: { initialQuery?: string }) {
  const navigate = useNavigate()
  const inputId = useId()

  const [inputVal, setInputVal] = useState(initialQuery)
  const [typeFilter, setTypeFilter] = useState<'' | ContentType>('')

  useEffect(() => {
    setInputVal(initialQuery)
  }, [initialQuery])

  useEffect(() => {
    document.title = initialQuery ? `搜索：${initialQuery} — Inkbranch` : '全站搜索 — Inkbranch'
  }, [initialQuery])

  const trimmed = inputVal.trim()

  const { data, isFetching } = useQuery({
    queryKey: ['search', trimmed, typeFilter],
    queryFn: () => searchContent({ q: trimmed, type: typeFilter, limit: 40 }),
    enabled: trimmed.length > 0,
    staleTime: 15_000,
  })

  const hits = data?.hits ?? []

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-4">
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          全站中英双语检索
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          支持中文切词、英文词干与 BM25F 加权排序，高亮命中上下文段落。
        </p>

        <search>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void navigate({ to: '/search', search: { q: inputVal.trim() } })
            }}
            className="flex flex-col gap-3 sm:flex-row"
          >
            <div className="relative flex-1">
              <label htmlFor={inputId} className="visually-hidden">
                输入搜索关键词
              </label>
              <Search
                className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <input
                id={inputId}
                type="search"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') {
                    void navigate({ to: '/search', search: { q: inputVal.trim() } })
                  }
                }}
                placeholder="输入关键词，例如 Go、原子写入、PostgreSQL、随笔..."
                autoComplete="off"
                autocorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="editorial-input pl-11"
              />
            </div>
            <button
              type="submit"
              className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-xl bg-[var(--accent)] px-6 text-sm font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
            >
              搜索
            </button>
          </form>
        </search>

        <div className="flex flex-wrap gap-2 text-xs">
          {(
            [
              { id: '', label: '全部类型' },
              { id: 'post', label: '长文' },
              { id: 'note', label: '随笔' },
              { id: 'project', label: '项目' },
            ] as const
          ).map((f) => (
            <button
              key={f.id || 'all'}
              type="button"
              aria-pressed={typeFilter === f.id}
              onClick={() => setTypeFilter(f.id)}
              className={`cursor-pointer rounded-lg border px-3 py-1 font-medium ${
                typeFilter === f.id
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {!trimmed ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          输入任意关键词开始检索，或随时按下 <kbd className="kbd-chip">⌘K</kbd> 唤出全局命令面板。
        </div>
      ) : isFetching && hits.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          正在检索中...
        </div>
      ) : hits.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          未找到与 “{trimmed}” 匹配的结果
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-xs text-[var(--text-muted)]">
            共找到 {data?.total ?? hits.length} 条相关内容
          </div>
          <ul className="space-y-3">
            {hits.map((hit) => (
              <li key={`${hit.type}:${hit.slug}`}>
                <Link
                  to={hit.url}
                  className="editorial-card editorial-card-interactive block p-5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                    <span className="inline-flex items-center gap-1.5 font-medium text-[var(--accent)]">
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      {collectionLabel(hit.type)}
                      {hit.category ? ` · ${hit.category}` : ''}
                    </span>
                    {hit.publishedAt ? (
                      <span className="font-mono">{formatDateISO(hit.publishedAt)}</span>
                    ) : null}
                  </div>
                  <h2 className="mt-1.5 text-lg font-bold text-[var(--text-primary)]">
                    {hit.title}
                  </h2>
                  {hit.snippetHtml ? (
                    <p
                      className="search-snippet mt-2 text-sm leading-relaxed text-[var(--text-secondary)]"
                      dangerouslySetInnerHTML={{ __html: hit.snippetHtml }}
                    />
                  ) : hit.description ? (
                    <p className="mt-2 text-sm text-[var(--text-secondary)]">
                      {hit.description}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
