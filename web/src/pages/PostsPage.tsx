import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookMarked } from 'lucide-react'
import { ContentCard } from '../components/ContentCard'
import { listContent } from '../lib/api'

export function PostsPage() {
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedLang, setSelectedLang] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['content-list', 'post'],
    queryFn: () => listContent({ type: 'post', limit: 100 }),
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '深度长文 Articles — Inkbranch'
  }, [])

  const items = data?.items ?? []

  const categories = useMemo(() => {
    const set = new Set<string>()
    items.forEach((d) => {
      if (d.category) set.add(d.category)
    })
    return Array.from(set).sort()
  }, [items])

  const langs = useMemo(() => {
    const set = new Set<string>()
    items.forEach((d) => {
      if (d.lang) set.add(d.lang)
    })
    return Array.from(set).sort()
  }, [items])

  const filtered = items.filter((item) => {
    if (selectedCategory && item.category !== selectedCategory) return false
    if (selectedLang && item.lang !== selectedLang) return false
    return true
  })

  return (
    <div className="space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <BookMarked className="h-4 w-4" aria-hidden="true" />
          <span>Articles · 长文专栏</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          深度长文与技术架构
        </h1>
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          围绕系统设计、基础设施运维、编程语言工程实践的体系化写作，共 {items.length} 篇已发布长文。
        </p>

        {categories.length > 0 || langs.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
            <button
              type="button"
              onClick={() => setSelectedCategory('')}
              aria-pressed={selectedCategory === ''}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 font-medium transition-colors ${
                selectedCategory === ''
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              全部分类
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                aria-pressed={selectedCategory === cat}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 font-medium transition-colors ${
                  selectedCategory === cat
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {cat}
              </button>
            ))}

            {langs.length > 1 ? (
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedLang('')}
                  aria-pressed={selectedLang === ''}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 font-mono ${
                    selectedLang === ''
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
                  }`}
                >
                  ALL
                </button>
                {langs.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setSelectedLang(l)}
                    aria-pressed={selectedLang === l}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 font-mono ${
                      selectedLang === l
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="editorial-card h-44 animate-pulse" />
          <div className="editorial-card h-44 animate-pulse" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          当前筛选条件下暂无文章
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {filtered.map((item) => (
            <ContentCard key={item.slug} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
