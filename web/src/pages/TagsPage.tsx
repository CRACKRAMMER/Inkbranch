import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Folder, Rss, Tag } from 'lucide-react'
import { ContentCard } from '../components/ContentCard'
import { listContent, listTags } from '../lib/api'

export function TagsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['tags'],
    queryFn: listTags,
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '标签索引 Tags — Inkbranch'
  }, [])

  const tags = data?.items ?? []

  return (
    <div className="space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <Tag className="h-4 w-4" aria-hidden="true" />
          <span>Topics & Tags</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          主题标签云
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          共汇集 {tags.length} 个主题标签，每个标签均提供独立 RSS 订阅源。
        </p>
      </header>

      {isLoading ? (
        <div className="editorial-card h-48 animate-pulse" />
      ) : (
        <div className="editorial-card flex flex-wrap gap-3 p-6">
          {tags.map((t) => (
            <Link
              key={t.slug}
              to="/tags/$tag"
              params={{ tag: t.slug }}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <span>#{t.name}</span>
              <span className="rounded-md bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]">
                {t.count}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function TagDetailPage({ tag }: { tag: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['content-list', 'tag', tag],
    queryFn: () => listContent({ tag, limit: 100 }),
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = `标签 #${tag} — Inkbranch`
  }, [tag])

  const items = data?.items ?? []

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--border-subtle)] pb-6">
        <div className="space-y-2">
          <Link
            to="/tags"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>全部标签</span>
          </Link>
          <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
            #{tag}
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            共 {items.length} 篇带此标签的内容
          </p>
        </div>

        <a
          href={`/tags/${encodeURIComponent(tag)}/feed.xml`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--accent)]"
        >
          <Rss className="h-3.5 w-3.5" aria-hidden="true" />
          <span>订阅该标签 RSS</span>
        </a>
      </header>

      {isLoading ? (
        <div className="editorial-card h-48 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          暂无包含此标签的内容
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {items.map((item) => (
            <ContentCard key={`${item.type}:${item.slug}`} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

export function CategoryDetailPage({ category }: { category: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['content-list', 'category', category],
    queryFn: () => listContent({ category, limit: 100 }),
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = `分类 ${category} — Inkbranch`
  }, [category])

  const items = data?.items ?? []

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--border-subtle)] pb-6">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
            <Folder className="h-4 w-4" aria-hidden="true" />
            <span>Category · 内容分类</span>
          </div>
          <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
            {category}
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            共 {items.length} 篇已发布内容
          </p>
        </div>

        <a
          href={`/categories/${encodeURIComponent(category)}/feed.xml`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--accent)]"
        >
          <Rss className="h-3.5 w-3.5" aria-hidden="true" />
          <span>订阅该分类 RSS</span>
        </a>
      </header>

      {isLoading ? (
        <div className="editorial-card h-48 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          该分类下暂无内容
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {items.map((item) => (
            <ContentCard key={`${item.type}:${item.slug}`} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
