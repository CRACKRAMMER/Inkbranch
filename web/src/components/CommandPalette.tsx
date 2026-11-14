import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Compass, FileText, Network, Search, Sparkles, X } from 'lucide-react'
import { searchContent } from '../lib/api'
import { attachClosedByFallback } from '../lib/dialog'
import { collectionLabel, formatDateISO } from '../lib/format'
import type { SearchHit } from '../lib/types'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (next: boolean) => void
}

const QUICK_LINKS = [
  { label: '深度长文 Posts', to: '/posts' },
  { label: '随笔花园 Notes', to: '/notes' },
  { label: '作品展厅 Projects', to: '/projects' },
  { label: '系列专栏 Series', to: '/series' },
  { label: '知识图谱 Graph', to: '/graph' },
  { label: '时间归档 Archive', to: '/archive' },
  { label: '友链与聚合 Friends', to: '/friends' },
] as const

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const inputId = useId()

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  // Sync dialog modal open/close & Safari light-dismiss fallback
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleNativeClose = () => onOpenChange(false)
    dialog.addEventListener('close', handleNativeClose)
    const cleanupFallback = attachClosedByFallback(dialog, () => onOpenChange(false))

    if (open) {
      if (!dialog.open) {
        dialog.showModal()
      }
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (dialog.open) {
      dialog.close()
    }

    return () => {
      dialog.removeEventListener('close', handleNativeClose)
      cleanupFallback()
    }
  }, [open, onOpenChange])

  // Debounced live search
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (!trimmed) {
      setHits([])
      setTotal(0)
      setActiveIndex(0)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const res = await searchContent({ q: trimmed, limit: 12 })
        if (!cancelled) {
          setHits(res.hits ?? [])
          setTotal(res.total ?? 0)
          setActiveIndex(0)
        }
      } catch {
        if (!cancelled) {
          setHits([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  const jumpTo = (url: string) => {
    onOpenChange(false)
    void navigate({ to: url })
  }

  const trimmed = query.trim()
  const itemsCount = trimmed ? hits.length : QUICK_LINKS.length

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby={titleId}
      className="editorial-dialog"
    >
      <div className="flex flex-col overflow-hidden">
        <search className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (trimmed && hits[activeIndex]) {
                jumpTo(hits[activeIndex].url)
              } else if (trimmed) {
                onOpenChange(false)
                void navigate({ to: '/search', search: { q: trimmed } })
              } else if (QUICK_LINKS[activeIndex]) {
                jumpTo(QUICK_LINKS[activeIndex].to)
              }
            }}
            className="flex items-center gap-3"
          >
            <Search className="h-5 w-5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <label htmlFor={inputId} id={titleId} className="visually-hidden">
              快速搜索文章、随笔、项目与站点导航
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'ArrowDown' && itemsCount > 0) {
                  e.preventDefault()
                  setActiveIndex((prev) => (prev + 1) % itemsCount)
                } else if (e.key === 'ArrowUp' && itemsCount > 0) {
                  e.preventDefault()
                  setActiveIndex((prev) => (prev - 1 + itemsCount) % itemsCount)
                }
              }}
              placeholder="搜索中英标题、标签、正文或直达页面..."
              autoComplete="off"
              autocorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-h-11 w-full bg-transparent text-base text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                aria-label="清空关键词"
                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="关闭命令面板"
              className="kbd-chip cursor-pointer hover:border-[var(--border-strong)]"
            >
              ESC
            </button>
          </form>
        </search>

        <div className="max-h-[min(28rem,62dvh)] overflow-y-auto p-3">
          {!trimmed ? (
            <div>
              <div className="mb-2 flex items-center justify-between px-2 text-xs font-medium text-[var(--text-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <Compass className="h-3.5 w-3.5" aria-hidden="true" />
                  快速导航
                </span>
                <span>使用 ↑ ↓ 回车跳转</span>
              </div>
              <ul className="space-y-1">
                {QUICK_LINKS.map((item, idx) => (
                  <li key={item.to}>
                    <button
                      type="button"
                      onClick={() => jumpTo(item.to)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={`flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                        activeIndex === idx
                          ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                          : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2.5">
                        <Network className="h-4 w-4 opacity-70" aria-hidden="true" />
                        {item.label}
                      </span>
                      <ArrowRight className="h-4 w-4 opacity-60" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : loading ? (
            <div className="py-10 text-center text-sm text-[var(--text-muted)]">
              正在检索中英双语索引...
            </div>
          ) : hits.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--text-secondary)]">
                未找到与 “{trimmed}” 匹配的内容
              </p>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  void navigate({ to: '/search', search: { q: trimmed } })
                }}
                className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                打开完整搜索页
              </button>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between px-2 text-xs text-[var(--text-muted)]">
                <span>匹配 {total} 篇结果</span>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    void navigate({ to: '/search', search: { q: trimmed } })
                  }}
                  className="cursor-pointer text-[var(--accent)] hover:underline"
                >
                  查看全部结果 →
                </button>
              </div>
              <ul className="space-y-1.5">
                {hits.map((hit, idx) => (
                  <li key={`${hit.type}:${hit.slug}`}>
                    <button
                      type="button"
                      onClick={() => jumpTo(hit.url)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={`w-full cursor-pointer rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                        activeIndex === idx
                          ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]'
                          : 'border-transparent hover:bg-[var(--bg-elevated)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--accent)]">
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                          {collectionLabel(hit.type)}
                          {hit.category ? ` · ${hit.category}` : ''}
                        </span>
                        {hit.publishedAt ? (
                          <span>{formatDateISO(hit.publishedAt)}</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-sm font-semibold text-[var(--text-primary)]">
                        {hit.title}
                      </div>
                      {hit.snippetHtml ? (
                        <p
                          className="search-snippet mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--text-secondary)]"
                          dangerouslySetInnerHTML={{ __html: hit.snippetHtml }}
                        />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}
