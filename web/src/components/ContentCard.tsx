import { Link } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, Calendar, Clock, ExternalLink, FolderGit2, Layers } from 'lucide-react'
import type { ContentSummary } from '../lib/types'
import { collectionLabel, formatDateISO, langLabel, projectStatusMeta } from '../lib/format'

interface ContentCardProps {
  item: ContentSummary
  variant?: 'default' | 'featured' | 'compact' | 'project'
  className?: string
}

function docRouteProps(item: ContentSummary) {
  switch (item.type) {
    case 'post':
      return { to: '/posts/$slug' as const, params: { slug: item.slug } }
    case 'note':
      return { to: '/notes/$slug' as const, params: { slug: item.slug } }
    case 'project':
      return { to: '/projects/$slug' as const, params: { slug: item.slug } }
  }
}

export function ContentCard({ item, variant = 'default', className = '' }: ContentCardProps) {
  const dateText = formatDateISO(item.publishedAt || item.updatedAt)
  const route = docRouteProps(item)

  if (variant === 'featured') {
    return (
      <article
        className={`editorial-card editorial-card-interactive group relative flex h-full flex-col justify-between overflow-hidden p-6 sm:p-8 ${className}`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -right-20 h-56 w-56 rounded-full bg-[var(--accent-soft)] blur-3xl transition-opacity group-hover:opacity-90"
        />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 font-semibold text-[var(--accent)]">
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              精选专栏 · {item.category || collectionLabel(item.type)}
            </span>
            {dateText ? (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
                <time dateTime={item.publishedAt || item.updatedAt}>{dateText}</time>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
              {item.readingMinutes} 分钟阅读
            </span>
            {item.series ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
                <Layers className="h-3 w-3" aria-hidden="true" />
                {item.series}
              </span>
            ) : null}
          </div>

          <h2 className="mt-4 text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-3xl">
            <Link
              to={route.to}
              params={route.params}
              className="after:absolute after:inset-0 focus-visible:outline-none"
            >
              {item.title}
            </Link>
          </h2>

          {item.description || item.summary ? (
            <p className="mt-3 line-clamp-3 text-base leading-relaxed text-[var(--text-secondary)]">
              {item.description || item.summary}
            </p>
          ) : null}
        </div>

        <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
          <div className="relative z-10 flex flex-wrap gap-1.5">
            {item.tags.slice(0, 4).map((tag) => (
              <Link
                key={tag}
                to="/tags/$tag"
                params={{ tag }}
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                #{tag}
              </Link>
            ))}
          </div>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] transition-transform group-hover:translate-x-0.5">
            阅读全文 <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
      </article>
    )
  }

  if (variant === 'project') {
    const meta = projectStatusMeta(item.projectStatus)
    return (
      <article
        className={`editorial-card editorial-card-interactive group relative flex flex-col justify-between p-5 sm:p-6 ${className}`}
      >
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${meta.badgeClass}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
              {meta.label}
            </span>
            {dateText ? (
              <time
                dateTime={item.publishedAt || item.updatedAt}
                className="font-mono text-xs text-[var(--text-muted)]"
              >
                {dateText}
              </time>
            ) : null}
          </div>

          <h3 className="mt-3.5 text-lg font-bold tracking-tight text-[var(--text-primary)]">
            <Link
              to={route.to}
              params={route.params}
              className="transition-colors group-hover:text-[var(--accent)]"
            >
              {item.title}
            </Link>
          </h3>

          {item.description ? (
            <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--text-secondary)]">
              {item.description}
            </p>
          ) : null}
        </div>

        <div className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4">
          {item.stack && item.stack.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {item.stack.slice(0, 5).map((tech) => (
                <span
                  key={tech}
                  className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
                >
                  {tech}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-medium">
            <Link
              to={route.to}
              params={route.params}
              className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
            >
              项目详情 & 复盘 <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <div className="flex items-center gap-3 text-[var(--text-secondary)]">
              {item.repoUrl ? (
                <a
                  href={item.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                >
                  <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>源码</span>
                </a>
              ) : null}
              {item.websiteUrl ? (
                <a
                  href={item.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>在线访问</span>
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </article>
    )
  }

  if (variant === 'compact') {
    return (
      <article
        className={`group flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-[var(--bg-elevated)] ${className}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="font-medium text-[var(--accent)]">{collectionLabel(item.type)}</span>
            {dateText ? (
              <time dateTime={item.publishedAt || item.updatedAt}>{dateText}</time>
            ) : null}
          </div>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
            <Link to={route.to} params={route.params}>
              {item.title}
            </Link>
          </h3>
        </div>
        <ArrowUpRight
          className="mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--accent)]"
          aria-hidden="true"
        />
      </article>
    )
  }

  return (
    <article
      className={`editorial-card editorial-card-interactive group flex flex-col justify-between p-5 sm:p-6 ${className}`}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="rounded-full bg-[var(--bg-elevated)] px-2.5 py-0.5 font-medium text-[var(--text-secondary)]">
            {collectionLabel(item.type)}
          </span>
          {item.category ? (
            <Link
              to="/categories/$category"
              params={{ category: item.category }}
              className="font-medium text-[var(--accent)] hover:underline"
            >
              {item.category}
            </Link>
          ) : null}
          {dateText ? (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={item.publishedAt || item.updatedAt}>{dateText}</time>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{item.readingMinutes} 分钟</span>
          {item.lang && item.lang.toLowerCase() !== 'zh-cn' ? (
            <span className="rounded-md border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-[11px]">
              {langLabel(item.lang)}
            </span>
          ) : null}
        </div>

        <h3 className="mt-3 text-lg font-bold tracking-tight text-[var(--text-primary)] sm:text-xl">
          <Link
            to={route.to}
            params={route.params}
            className="transition-colors group-hover:text-[var(--accent)]"
          >
            {item.title}
          </Link>
        </h3>

        {item.description || item.summary ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            {item.description || item.summary}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 text-xs">
        <div className="flex flex-wrap gap-1.5">
          {item.tags.slice(0, 4).map((tag) => (
            <Link
              key={tag}
              to="/tags/$tag"
              params={{ tag }}
              className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              #{tag}
            </Link>
          ))}
        </div>
        {item.series ? (
          <Link
            to="/series/$series"
            params={{ series: item.series }}
            className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--accent)]"
          >
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{item.series}</span>
          </Link>
        ) : null}
      </div>
    </article>
  )
}
