import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, NotebookPen } from 'lucide-react'
import { listContent } from '../lib/api'
import { formatDateISO } from '../lib/format'

export function NotesPage() {
  const [selectedTag, setSelectedTag] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['content-list', 'note'],
    queryFn: () => listContent({ type: 'note', limit: 100 }),
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '随笔花园 Notes — Inkbranch'
  }, [])

  const items = data?.items ?? []

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    items.forEach((n) => {
      n.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1))
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [items])

  const filtered = selectedTag
    ? items.filter((item) => item.tags.includes(selectedTag))
    : items

  return (
    <div className="space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-sky-600 dark:text-sky-400">
          <NotebookPen className="h-4 w-4" aria-hidden="true" />
          <span>Garden Notes · 轻量随笔与片段记录</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          随笔花园与工程卡片
        </h1>
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          日常调试踩坑（TIL）、临时灵光、代码片段与轻量读书笔记，共 {items.length} 条记录。
        </p>

        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-2 text-xs">
            <button
              type="button"
              onClick={() => setSelectedTag('')}
              aria-pressed={selectedTag === ''}
              className={`cursor-pointer rounded-lg border px-3 py-1 font-medium ${
                selectedTag === ''
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
              }`}
            >
              全部笔记
            </button>
            {tags.slice(0, 14).map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTag(tag)}
                aria-pressed={selectedTag === tag}
                className={`cursor-pointer rounded-lg border px-2.5 py-1 font-medium ${
                  selectedTag === tag
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
                }`}
              >
                #{tag} ({count})
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {isLoading ? (
        <div className="space-y-4">
          <div className="editorial-card h-28 animate-pulse" />
          <div className="editorial-card h-28 animate-pulse" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          当前标签下暂无随笔
        </div>
      ) : (
        <ol className="relative space-y-4 border-l-2 border-[var(--border-subtle)] pl-6">
          {filtered.map((note, idx) => (
            <li
              key={note.slug}
              className={idx >= 6 ? 'deferred-item relative' : 'relative'}
            >
              <span
                aria-hidden="true"
                className="absolute top-6 -left-[1.92rem] h-3 w-3 rounded-full border-2 border-[var(--bg-canvas)] bg-[var(--accent)]"
              />
              <article className="editorial-card editorial-card-interactive p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                  <time dateTime={note.publishedAt || note.updatedAt} className="font-mono">
                    {formatDateISO(note.publishedAt || note.updatedAt)}
                  </time>
                  <span>{note.wordCount} 字 · {note.readingMinutes} 分钟</span>
                </div>
                <h2 className="mt-2 text-lg font-bold tracking-tight text-[var(--text-primary)]">
                  <Link
                    to="/notes/$slug"
                    params={{ slug: note.slug }}
                    className="inline-flex items-center gap-1.5 hover:text-[var(--accent)]"
                  >
                    <span>{note.title}</span>
                    <ArrowUpRight className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
                  </Link>
                </h2>
                {note.description || note.summary ? (
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                    {note.description || note.summary}
                  </p>
                ) : null}
                {note.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {note.tags.map((t) => (
                      <Link
                        key={t}
                        to="/tags/$tag"
                        params={{ tag: t }}
                        className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]"
                      >
                        #{t}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
