import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, BookMarked, FolderGit2, Layers, NotebookPen, Rss, Sparkles, Tag } from 'lucide-react'
import { ContentCard } from '../components/ContentCard'
import { getHome, listContent } from '../lib/api'
import { formatDateISO, projectStatusMeta } from '../lib/format'
import type { ContentType } from '../lib/types'

export function HomePage() {
  const { data: home, isLoading } = useQuery({
    queryKey: ['home'],
    queryFn: getHome,
    staleTime: 60_000,
  })

  const [streamFilter, setStreamFilter] = useState<'all' | ContentType>('all')

  const { data: streamData } = useQuery({
    queryKey: ['home-stream', streamFilter],
    queryFn: () =>
      listContent({
        type: streamFilter === 'all' ? '' : streamFilter,
        limit: 10,
      }),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (home?.site?.name) {
      document.title = `${home.site.name} — ${home.site.description}`
    }
    document.documentElement.lang = 'zh-CN'
  }, [home])

  if (isLoading && !home) {
    return (
      <div className="space-y-6">
        <div className="editorial-card h-36 animate-pulse p-6" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="editorial-card h-72 animate-pulse lg:col-span-7" />
          <div className="editorial-card h-72 animate-pulse lg:col-span-5" />
        </div>
      </div>
    )
  }

  const featured = home?.featuredPost
  const activeProjects = home?.activeProjects ?? []
  const recentNotes = home?.recentNotes ?? []
  const popularTags = home?.popularTags ?? []
  const fallbackStream = [
    ...(home?.recentPosts ?? []),
    ...(home?.recentNotes ?? []),
    ...(home?.activeProjects ?? []),
  ].slice(0, 10)
  const streamItems = streamData?.items ?? fallbackStream

  return (
    <div className="space-y-10">
      {/* Compact Personal Intro Strip */}
      <section className="editorial-card relative overflow-hidden p-6 sm:p-8">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div className="max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              <span>CRACKRAMMER · 数字花园与长期技术专栏</span>
            </div>
            <h1
              id="page-heading"
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-4xl"
            >
              {home?.site.name ?? 'Inkbranch · 墨枝'}
            </h1>
            <p className="text-base leading-relaxed text-[var(--text-secondary)]">
              {home?.site.description ??
                '记录系统架构、编程语言工程实践、工具创造与长期主义阅读思考。'}
            </p>
          </div>

          <div className="flex flex-col items-start gap-3 md:items-end">
            <div className="flex flex-wrap gap-2 text-xs">
              <Link
                to="/posts"
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <BookMarked className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                <span>{home?.counts.posts ?? 0} 长文</span>
              </Link>
              <Link
                to="/notes"
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <NotebookPen className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                <span>{home?.counts.notes ?? 0} 随笔</span>
              </Link>
              <Link
                to="/projects"
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <FolderGit2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                <span>{home?.counts.projects ?? 0} 项目</span>
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
              <a
                href="/feed.xml"
                className="inline-flex items-center gap-1 hover:text-[var(--accent)]"
              >
                <Rss className="h-3.5 w-3.5" aria-hidden="true" /> RSS 订阅
              </a>
              <span aria-hidden="true">·</span>
              <a
                href="/llms.txt"
                className="inline-flex items-center gap-1 hover:text-[var(--accent)]"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> /llms.txt
              </a>
              <span aria-hidden="true">·</span>
              <Link to="/graph" className="hover:text-[var(--accent)]">
                浏览知识图谱 →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Asymmetric Bento Showcase */}
      <section aria-label="精选推荐" className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          {featured ? (
            <ContentCard item={featured} variant="featured" />
          ) : (
            <div className="editorial-card flex h-full items-center justify-center p-8 text-sm text-[var(--text-muted)]">
              暂无精选长文
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6 lg:col-span-5">
          {/* Active Projects Bento Card */}
          <div className="editorial-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
                <FolderGit2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                <span>活跃项目 Showcase</span>
              </h2>
              <Link
                to="/projects"
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
              >
                全部 <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
            {activeProjects.length > 0 ? (
              <ul className="space-y-2.5">
                {activeProjects.slice(0, 3).map((proj) => {
                  const meta = projectStatusMeta(proj.projectStatus)
                  return (
                    <li
                      key={proj.slug}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 p-3 transition-colors hover:border-[var(--border-strong)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          to="/projects/$slug"
                          params={{ slug: proj.slug }}
                          className="truncate text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)]"
                        >
                          {proj.title}
                        </Link>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${meta.dotClass}`}
                          title={meta.label}
                        />
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-[var(--text-secondary)]">
                        {proj.description}
                      </p>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">暂无项目记录</p>
            )}
          </div>

          {/* Recent Notes Bento Card */}
          <div className="editorial-card flex-1 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
                <NotebookPen className="h-4 w-4 text-sky-500" aria-hidden="true" />
                <span>近期随笔 Garden Notes</span>
              </h2>
              <Link
                to="/notes"
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
              >
                全部 <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
            {recentNotes.length > 0 ? (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {recentNotes.slice(0, 4).map((note) => (
                  <li key={note.slug} className="py-2 first:pt-0 last:pb-0">
                    <Link
                      to="/notes/$slug"
                      params={{ slug: note.slug }}
                      className="group flex items-baseline justify-between gap-3"
                    >
                      <span className="truncate text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                        {note.title}
                      </span>
                      <time
                        dateTime={note.publishedAt || note.updatedAt}
                        className="shrink-0 font-mono text-xs text-[var(--text-muted)]"
                      >
                        {formatDateISO(note.publishedAt || note.updatedAt)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">暂无随笔笔记</p>
            )}
          </div>
        </div>
      </section>

      {/* Filterable Content Stream + Popular Tags */}
      <section aria-label="最新内容流" className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              最新发布
            </h2>
            <div
              role="group"
              aria-label="按内容类型筛选"
              className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1 text-xs font-medium"
            >
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'post', label: '长文' },
                  { id: 'note', label: '随笔' },
                  { id: 'project', label: '项目' },
                ] as const
              ).map((tab) => {
                const active = streamFilter === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setStreamFilter(tab.id)}
                    className={`cursor-pointer rounded-lg px-3 py-1.5 transition-colors ${
                      active
                        ? 'bg-[var(--accent)] font-semibold text-[var(--accent-ink)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {streamItems.map((item) => (
              <ContentCard key={`${item.type}:${item.slug}`} item={item} />
            ))}
          </div>
        </div>

        <aside aria-label="热门话题与专栏" className="space-y-6 lg:col-span-4">
          <div className="editorial-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
                <Tag className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                <span>热门主题标签</span>
              </h2>
              <Link to="/tags" className="text-xs font-medium text-[var(--accent)] hover:underline">
                全部 {home?.counts.tags ?? popularTags.length}
              </Link>
            </div>
            <div className="flex flex-wrap gap-2">
              {popularTags.map((t) => (
                <Link
                  key={t.slug}
                  to="/tags/$tag"
                  params={{ tag: t.slug }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <span>#{t.name}</span>
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {t.count}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          <div className="editorial-card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
              <Layers className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
              <span>专题探索</span>
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
              目前共沉淀了 {home?.counts.series ?? 0} 个系统性专栏系列。通过双向链接与局部图谱快速穿梭于相关主题之间。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/series"
                className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                进入系列专栏 →
              </Link>
              <Link
                to="/archive"
                className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                查看时间归档 →
              </Link>
            </div>
          </div>
        </aside>
      </section>
    </div>
  )
}
