import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUpRight,
  Calendar,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileCode2,
  FolderGit2,
  Globe,
  Link2,
  MessageSquare,
  Type,
} from 'lucide-react'
import { ArticleEnhancers } from '../components/ArticleEnhancers'
import { CommentsSection } from '../components/CommentsSection'
import { KnowledgeGraphCanvas } from '../components/KnowledgeGraphCanvas'
import { NewsletterBox } from '../components/NewsletterBox'
import { ReactionsBar } from '../components/ReactionsBar'
import { SeriesCard } from '../components/SeriesCard'
import { TOC } from '../components/TOC'
import {
  fetchRawMarkdown,
  getContentDetail,
  sendAnalyticsBeacon,
} from '../lib/api'
import { collectionLabel, formatDateLong, langLabel, projectStatusMeta } from '../lib/format'
import {
  ensureChromaStylesheet,
  getReadingFont,
  setReadingFont,
  type ReadingFont,
} from '../lib/theme'
import type { ContentDetailBody, ContentType } from '../lib/types'
import { NotFoundPage } from './NotFoundPage'

interface ArticleViewProps {
  detail: ContentDetailBody
  isPreview?: boolean
  previewExpiresAt?: string
}

function docListRoute(type: ContentType) {
  if (type === 'note') return '/notes' as const
  if (type === 'project') return '/projects' as const
  return '/posts' as const
}

export function ArticleWorkbench({
  detail,
  isPreview = false,
  previewExpiresAt,
}: ArticleViewProps) {
  const navigate = useNavigate()
  const { document: doc, context } = detail

  const [font, setFont] = useState<ReadingFont>(() => getReadingFont())
  const [copiedMd, setCopiedMd] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)

  useEffect(() => {
    ensureChromaStylesheet()
    document.title = doc.seo?.title || `${doc.title} — Inkbranch`
    document.documentElement.lang = doc.lang || 'zh-CN'
  }, [doc])

  // Privacy-first pageview & scroll reading depth analytics
  useEffect(() => {
    if (isPreview) return
    const startedAt = Date.now()
    let maxDepth = 0

    sendAnalyticsBeacon({
      eventType: 'pageview',
      contentType: doc.type,
      slug: doc.slug,
      path: doc.url,
      referrer: document.referrer || undefined,
    })

    const onScroll = () => {
      const scrollHeight =
        document.documentElement.scrollHeight - window.innerHeight
      if (scrollHeight > 0) {
        const pct = Math.min(100, Math.round((window.scrollY / scrollHeight) * 100))
        if (pct > maxDepth) maxDepth = pct
      }
    }

    const flushDepth = () => {
      const dwellSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      sendAnalyticsBeacon({
        eventType: 'read_depth',
        contentType: doc.type,
        slug: doc.slug,
        path: doc.url,
        maxDepth,
        dwellSeconds,
      })
    }

    const onVisChange = () => {
      if (document.visibilityState === 'hidden') flushDepth()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisChange)
    return () => {
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisChange)
      flushDepth()
    }
  }, [doc.type, doc.slug, doc.url, isPreview])

  const toggleFont = () => {
    const next: ReadingFont = font === 'sans' ? 'serif' : 'sans'
    setFont(next)
    setReadingFont(next)
  }

  const handleCopyMarkdown = async () => {
    try {
      const raw = doc.rawMarkdown || (await fetchRawMarkdown(doc.markdownUrl))
      await navigator.clipboard?.writeText(raw)
      setCopiedMd(true)
      window.setTimeout(() => setCopiedMd(false), 1800)
    } catch {
      // Clipboard fallback ignored
    }
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href)
      setCopiedUrl(true)
      window.setTimeout(() => setCopiedUrl(false), 1800)
    } catch {
      // Clipboard fallback ignored
    }
  }

  const hasTranslations = context.translations && context.translations.length > 0
  const localGraphNodesCount = context.localGraph?.nodes?.length ?? 0

  return (
    <div
      className={font === 'serif' ? 'reading-font-serif' : 'reading-font-sans'}
    >
      {isPreview ? (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-sm text-amber-800 dark:text-amber-200"
        >
          <span className="font-semibold">
            私密草稿预览链接（未公开发布 · 禁止搜索引擎收录）
          </span>
          {previewExpiresAt ? (
            <span className="font-mono text-xs">
              有效期至：{formatDateLong(previewExpiresAt)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Sticky Interaction Rail */}
        <aside
          aria-label="快捷阅读工具"
          className="hidden xl:col-span-1 xl:block"
        >
          <div className="sticky top-24 flex flex-col items-center gap-3">
            {!isPreview ? (
              <ReactionsBar
                contentType={doc.type}
                slug={doc.slug}
                orientation="vertical"
              />
            ) : null}

            <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-card)]">
              <a
                href="#comments"
                aria-label="跳转到评论区"
                title="评论区"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
              </a>

              <button
                type="button"
                onClick={() => void handleCopyMarkdown()}
                aria-label="复制全文 Markdown"
                title="复制全文 Markdown"
                className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                {copiedMd ? (
                  <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                ) : (
                  <FileCode2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                onClick={() => void handleCopyLink()}
                aria-label="复制文章分享链接"
                title="复制文章链接"
                className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--accent)]"
              >
                {copiedUrl ? (
                  <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                ) : (
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </aside>

        {/* Center Reading Column (max 70ch editorial cadence) */}
        <article className="min-w-0 lg:col-span-8 xl:col-span-8">
          <div className="mx-auto max-w-[70ch]">
            {/* Breadcrumb & Controls Row */}
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <Link
                to={docListRoute(doc.type)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent)]"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>返回{collectionLabel(doc.type)}列表</span>
              </Link>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleFont}
                  aria-pressed={font === 'serif'}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <Type className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                  <span>{font === 'serif' ? '书卷衬线体' : '现代无衬线'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleCopyMarkdown()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  {copiedMd ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                      <span>已复制 Markdown</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>复制 .md</span>
                    </>
                  )}
                </button>

                {!isPreview ? (
                  <a
                    href={doc.markdownUrl}
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--accent)]"
                  >
                    .md 原文
                  </a>
                ) : null}
              </div>
            </div>

            {/* Article Header */}
            <header className="space-y-4 border-b border-[var(--border-subtle)] pb-6">
              <div className="flex flex-wrap items-center gap-2.5 text-xs text-[var(--text-secondary)]">
                <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 font-semibold text-[var(--accent)]">
                  {collectionLabel(doc.type)}
                </span>
                {doc.category ? (
                  <Link
                    to="/categories/$category"
                    params={{ category: doc.category }}
                    className="font-medium hover:text-[var(--accent)] hover:underline"
                  >
                    {doc.category}
                  </Link>
                ) : null}
                {doc.publishedAt || doc.updatedAt ? (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
                    <time dateTime={doc.publishedAt || doc.updatedAt}>
                      {formatDateLong(doc.publishedAt || doc.updatedAt)}
                    </time>
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
                  {doc.readingMinutes} 分钟（{doc.wordCount} 字）
                </span>
              </div>

              <h1
                id="page-heading"
                tabIndex={-1}
                className="text-3xl font-bold tracking-tight text-[var(--text-primary)] sm:text-4xl"
              >
                {doc.title}
              </h1>

              {doc.description ? (
                <p className="text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
                  {doc.description}
                </p>
              ) : null}

              {/* Bilingual Language Switcher Pill */}
              {hasTranslations ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                    <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                    语言版本：
                  </span>
                  <span className="rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--accent)]">
                    {langLabel(doc.lang)}
                  </span>
                  {context.translations.map((tr) => (
                    <Link
                      key={tr.url}
                      to={tr.url}
                      title={tr.title}
                      className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                    >
                      {langLabel(tr.lang)}
                    </Link>
                  ))}
                </div>
              ) : null}

              {/* Project Metadata Banner */}
              {doc.type === 'project' ? (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${projectStatusMeta(doc.projectStatus).badgeClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${projectStatusMeta(doc.projectStatus).dotClass}`}
                        aria-hidden="true"
                      />
                      {projectStatusMeta(doc.projectStatus).label}
                    </span>
                    <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
                      {doc.repoUrl ? (
                        <a
                          href={doc.repoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                        >
                          <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>仓库源码</span>
                        </a>
                      ) : null}
                      {doc.websiteUrl ? (
                        <a
                          href={doc.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>在线演示</span>
                        </a>
                      ) : null}
                    </div>
                  </div>
                  {doc.stack && doc.stack.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {doc.stack.map((s) => (
                        <span
                          key={s}
                          className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </header>

            {context.seriesNav ? <SeriesCard seriesNav={context.seriesNav} /> : null}

            {/* Rendered Body with Interactive Enhancers */}
            <div className="py-6">
              <ArticleEnhancers
                renderedHtml={doc.renderedHtml}
                onNavigate={(url) => void navigate({ to: url })}
              />
            </div>

            {/* Bottom Series Nav if applicable */}
            {context.seriesNav ? <SeriesCard seriesNav={context.seriesNav} /> : null}

            {/* Tags Footer & Reactions */}
            <div className="space-y-5 border-t border-[var(--border-subtle)] pt-6">
              {doc.tags.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-[var(--text-muted)]">标签：</span>
                  {doc.tags.map((tag) => (
                    <Link
                      key={tag}
                      to="/tags/$tag"
                      params={{ tag }}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                    >
                      #{tag}
                    </Link>
                  ))}
                </div>
              ) : null}

              {!isPreview ? (
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    这篇文章对你有帮助吗？留个轻量表态吧
                  </span>
                  <ReactionsBar
                    contentType={doc.type}
                    slug={doc.slug}
                    orientation="horizontal"
                  />
                </div>
              ) : null}
            </div>

            {/* Backlinks & Related */}
            {context.backlinks.length > 0 || context.related.length > 0 ? (
              <section aria-label="延伸阅读与双向引用" className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {context.backlinks.length > 0 ? (
                  <div className="editorial-card p-5">
                    <h2 className="text-sm font-bold text-[var(--text-primary)]">
                      双向链接引用 ({context.backlinks.length})
                    </h2>
                    <ul className="mt-3 space-y-2.5">
                      {context.backlinks.map((bl) => (
                        <li key={bl.url}>
                          <Link
                            to={bl.url}
                            className="group block rounded-lg p-1.5 hover:bg-[var(--bg-elevated)]"
                          >
                            <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                              <span className="truncate">{bl.title}</span>
                              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            </div>
                            {bl.contextSnippet ? (
                              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
                                {bl.contextSnippet}
                              </p>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {context.related.length > 0 ? (
                  <div className="editorial-card p-5">
                    <h2 className="text-sm font-bold text-[var(--text-primary)]">
                      相关延伸阅读
                    </h2>
                    <ul className="mt-3 space-y-2.5">
                      {context.related.map((rel) => (
                        <li key={rel.url}>
                          <Link
                            to={rel.url}
                            className="group block rounded-lg p-1.5 hover:bg-[var(--bg-elevated)]"
                          >
                            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                              <span className="truncate">{rel.title}</span>
                              <span className="shrink-0 font-normal text-[var(--text-muted)]">
                                {rel.readingMinutes}m
                              </span>
                            </div>
                            {rel.description ? (
                              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
                                {rel.description}
                              </p>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            {!isPreview ? (
              <>
                <div className="mt-8">
                  <NewsletterBox lang={doc.lang} />
                </div>
                <CommentsSection
                  contentType={doc.type}
                  slug={doc.slug}
                  commentsEnabled={doc.commentsEnabled}
                />
              </>
            ) : null}
          </div>
        </article>

        {/* Right Sticky Rail: Scroll-Spy TOC + Local Knowledge Mini-Graph */}
        <aside
          aria-label="目录与关系图谱"
          className="space-y-5 lg:col-span-4 xl:col-span-3"
        >
          <div className="sticky top-24 space-y-5">
            {doc.tocEnabled ? <TOC headings={doc.headings} /> : null}

            {localGraphNodesCount > 1 ? (
              <div className="hidden lg:block">
                <div className="mb-2 flex items-center justify-between px-1 text-xs">
                  <span className="font-semibold text-[var(--text-muted)]">
                    局部关系邻域 ({localGraphNodesCount})
                  </span>
                  <Link to="/graph" className="text-[var(--accent)] hover:underline">
                    全局图谱 →
                  </Link>
                </div>
                <KnowledgeGraphCanvas
                  graph={context.localGraph}
                  mode="mini"
                  highlightNodeId={`${doc.type}:${doc.slug}`}
                />
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}

export function ArticlePage({
  docType,
  slug,
}: {
  docType: ContentType
  slug: string
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['content-detail', docType, slug],
    queryFn: () => getContentDetail(docType, slug),
    staleTime: 60_000,
    retry: false,
  })

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[70ch] space-y-4">
        <div className="h-8 w-2/3 animate-pulse rounded-lg bg-[var(--bg-elevated)]" />
        <div className="h-5 w-1/3 animate-pulse rounded-lg bg-[var(--bg-elevated)]" />
        <div className="editorial-card h-96 animate-pulse p-6" />
      </div>
    )
  }

  if (isError || !data) {
    return <NotFoundPage />
  }

  return <ArticleWorkbench detail={data} />
}
