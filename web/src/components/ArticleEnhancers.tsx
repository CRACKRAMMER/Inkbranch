import { memo, useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, X } from 'lucide-react'
import { getContentDetail } from '../lib/api'
import { attachClosedByFallback } from '../lib/dialog'
import { collectionLabel, formatDateISO } from '../lib/format'
import type { ContentDetailBody, ContentType } from '../lib/types'

interface ArticleEnhancersProps {
  renderedHtml: string
  onNavigate?: (url: string) => void
}

interface HoverPreviewState {
  title: string
  description: string
  typeLabel: string
  dateText: string
  readingMinutes: number
  loading: boolean
  href: string
}

const ProseContent = memo(function ProseContent({ html }: { html: string }) {
  return (
    <div
      className="editorial-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

function isValidContentType(raw: string): raw is ContentType {
  return raw === 'post' || raw === 'note' || raw === 'project'
}

export function ArticleEnhancers({ renderedHtml, onNavigate }: ArticleEnhancersProps) {
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const lightboxRef = useRef<HTMLDialogElement>(null)
  const hovercardRef = useRef<HTMLDivElement>(null)

  const lightboxCaptionId = useId()
  const hovercardId = useId()

  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null)
  const [copyStatusAnnouncement, setCopyStatusAnnouncement] = useState('')
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null)
  const [fallbackCoords, setFallbackCoords] = useState<{ top: number; left: number } | null>(null)
  const [supportsAnchorPos, setSupportsAnchorPos] = useState(false)

  useEffect(() => {
    try {
      setSupportsAnchorPos(
        typeof CSS !== 'undefined' &&
          typeof CSS.supports === 'function' &&
          CSS.supports('position-area', 'block-end'),
      )
    } catch {
      setSupportsAnchorPos(false)
    }
  }, [])

  // Initialize collapsible code blocks, heading anchors, and prose delegation
  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const createdExpands: HTMLElement[] = []
    const createdAnchors: HTMLElement[] = []

    // 1. Initialize collapsible code blocks (> 30 lines)
    root.querySelectorAll<HTMLElement>('figure.md-code-block[data-collapsible="true"]').forEach((fig) => {
      if (fig.querySelector('.md-code-expand')) return
      const linesCount = fig.querySelectorAll('.md-code-line').length
      fig.setAttribute('data-collapsed', 'true')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'md-code-expand'
      btn.setAttribute('aria-expanded', 'false')
      btn.textContent = `展开全部代码 (${linesCount} 行)`
      fig.appendChild(btn)
      createdExpands.push(btn)
    })

    // 2. Append accessible heading anchor links (#)
    root.querySelectorAll<HTMLElement>('h2[id], h3[id], h4[id]').forEach((heading) => {
      if (heading.querySelector('.md-heading-anchor')) return
      const anchor = document.createElement('a')
      anchor.className = 'md-heading-anchor'
      anchor.href = `#${heading.id}`
      anchor.setAttribute('aria-label', `链接到小节 ${heading.textContent?.trim() ?? heading.id}`)
      anchor.textContent = '#'
      heading.appendChild(anchor)
      createdAnchors.push(anchor)
    })

    // 3. Click delegation (Copy code, Expand collapsed code, Tabs, Image Lightbox, Internal/Wikilink SPA nav)
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return

      // Copy code button
      const copyBtn = target.closest<HTMLButtonElement>('[data-copy-code="true"]')
      if (copyBtn) {
        const fig = copyBtn.closest('figure.md-code-block')
        if (fig) {
          const lines = Array.from(fig.querySelectorAll('.md-cl')).map((el) => el.textContent ?? '')
          const plain = lines.join('\n')
          void navigator.clipboard?.writeText(plain).then(() => {
            const orig = copyBtn.textContent ?? 'Copy'
            copyBtn.textContent = '已复制 ✓'
            setCopyStatusAnnouncement('代码已复制到剪贴板')
            window.setTimeout(() => {
              copyBtn.textContent = orig
            }, 1800)
          })
        }
        return
      }

      // Expand/collapse code block
      const expandBtn = target.closest<HTMLButtonElement>('.md-code-expand')
      if (expandBtn) {
        const fig = expandBtn.closest<HTMLElement>('figure.md-code-block')
        if (fig) {
          const isCollapsed = fig.getAttribute('data-collapsed') === 'true'
          const linesCount = fig.querySelectorAll('.md-code-line').length
          fig.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true')
          expandBtn.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false')
          expandBtn.textContent = isCollapsed ? '收起长代码块' : `展开全部代码 (${linesCount} 行)`
        }
        return
      }

      // Tabs button
      const tabBtn = target.closest<HTMLButtonElement>('.md-tabs [role="tab"]')
      if (tabBtn) {
        const tabsRoot = tabBtn.closest('.md-tabs')
        const idx = tabBtn.getAttribute('data-tab-index')
        if (tabsRoot && idx !== null) {
          tabsRoot.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((btn) => {
            const active = btn.getAttribute('data-tab-index') === idx
            btn.classList.toggle('is-active', active)
            btn.setAttribute('aria-selected', active ? 'true' : 'false')
          })
          tabsRoot.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((panel) => {
            const active = panel.getAttribute('data-tab-panel') === idx
            panel.hidden = !active
          })
        }
        return
      }

      // Image click -> Lightbox
      const img = target.closest<HTMLImageElement>('img')
      if (img && root.contains(img)) {
        const src = img.currentSrc || img.src
        if (src) {
          setLightboxImage({
            src,
            alt: img.alt || '文章插图预览',
          })
        }
        return
      }

      // Internal link click -> TanStack Router SPA navigation
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (anchor && root.contains(anchor) && onNavigate) {
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          e.button !== 0 ||
          anchor.target === '_blank'
        ) {
          return
        }
        const href = anchor.getAttribute('href') ?? ''
        if (href.startsWith('/') && !href.startsWith('//') && !href.endsWith('.md')) {
          e.preventDefault()
          onNavigate(href)
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const tabBtn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.md-tabs [role="tab"]')
      if (!tabBtn) return
      const tabs = Array.from(tabBtn.closest('.md-tabs')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      if (tabs.length === 0) return
      const curIdx = tabs.indexOf(tabBtn)
      let nextIdx = -1
      if (e.key === 'ArrowRight') nextIdx = (curIdx + 1) % tabs.length
      else if (e.key === 'ArrowLeft') nextIdx = (curIdx - 1 + tabs.length) % tabs.length
      else if (e.key === 'Home') nextIdx = 0
      else if (e.key === 'End') nextIdx = tabs.length - 1
      const targetTab = nextIdx >= 0 ? tabs[nextIdx] : undefined
      if (targetTab) {
        e.preventDefault()
        targetTab.focus()
        targetTab.click()
      }
    }

    root.addEventListener('click', onClick)
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('keydown', onKeyDown)
      createdExpands.forEach((el) => el.remove())
      createdAnchors.forEach((el) => el.remove())
    }
  }, [renderedHtml, onNavigate])

  // Sync Image Lightbox <dialog> modal
  useEffect(() => {
    const dialog = lightboxRef.current
    if (!dialog) return

    const handleClose = () => setLightboxImage(null)
    dialog.addEventListener('close', handleClose)
    const cleanupFallback = attachClosedByFallback(dialog, () => setLightboxImage(null))

    if (lightboxImage) {
      if (!dialog.open) {
        dialog.showModal()
      }
    } else if (dialog.open) {
      dialog.close()
    }

    return () => {
      dialog.removeEventListener('close', handleClose)
      cleanupFallback()
    }
  }, [lightboxImage])

  // Wikilink Hovercard [popover="manual"] with CSS Anchor Positioning + coordinate fallback
  useEffect(() => {
    const root = containerRef.current
    const card = hovercardRef.current
    if (!root || !card) return

    card.setAttribute('popover', 'manual')

    let activeLink: HTMLAnchorElement | null = null
    let showTimer = 0
    let hideTimer = 0

    const clearTimers = () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(hideTimer)
    }

    const closeHovercard = () => {
      clearTimers()
      if (activeLink) {
        activeLink.removeAttribute('aria-describedby')
        if (supportsAnchorPos) {
          ;(activeLink.style as CSSStyleDeclaration & { anchorName?: string }).anchorName = ''
        }
        activeLink = null
      }
      if (card.matches(':popover-open')) {
        try {
          card.hidePopover()
        } catch {
          // Ignore
        }
      }
      setHoverPreview(null)
    }

    const scheduleClose = () => {
      window.clearTimeout(showTimer)
      hideTimer = window.setTimeout(closeHovercard, 160)
    }

    const openForLink = (link: HTMLAnchorElement) => {
      const docType = link.getAttribute('data-wikilink-type') ?? ''
      const slug = link.getAttribute('data-wikilink-slug') ?? ''
      const href = link.getAttribute('href') ?? ''
      if (!isValidContentType(docType) || !slug) return

      clearTimers()
      showTimer = window.setTimeout(async () => {
        if (activeLink && activeLink !== link) {
          activeLink.removeAttribute('aria-describedby')
          if (supportsAnchorPos) {
            ;(activeLink.style as CSSStyleDeclaration & { anchorName?: string }).anchorName = ''
          }
        }
        activeLink = link
        link.setAttribute('aria-describedby', hovercardId)

        if (supportsAnchorPos) {
          const anchorToken = '--wikilink-active-anchor'
          ;(link.style as CSSStyleDeclaration & { anchorName?: string }).anchorName = anchorToken
          ;(card.style as CSSStyleDeclaration & { positionAnchor?: string }).positionAnchor = anchorToken
          setFallbackCoords(null)
        } else {
          const rect = link.getBoundingClientRect()
          const maxLeft = Math.max(12, window.innerWidth - 364)
          setFallbackCoords({
            top: Math.min(window.innerHeight - 180, rect.bottom + 8),
            left: Math.min(maxLeft, Math.max(12, rect.left)),
          })
        }

        setHoverPreview({
          title: link.textContent?.trim() || slug,
          description: '',
          typeLabel: collectionLabel(docType),
          dateText: '',
          readingMinutes: 1,
          loading: true,
          href,
        })

        try {
          card.showPopover()
        } catch {
          // Popover unsupported fallback safely ignored
        }

        try {
          const detail = await queryClient.fetchQuery<ContentDetailBody>({
            queryKey: ['content-detail', docType, slug],
            queryFn: () => getContentDetail(docType, slug),
            staleTime: 60_000,
          })
          if (activeLink === link) {
            setHoverPreview({
              title: detail.document.title,
              description: detail.document.description || detail.document.summary || '点击打开关联内容',
              typeLabel: collectionLabel(detail.document.type),
              dateText: formatDateISO(detail.document.publishedAt || detail.document.updatedAt),
              readingMinutes: detail.document.readingMinutes,
              loading: false,
              href: detail.document.url,
            })
          }
        } catch {
          if (activeLink === link) {
            setHoverPreview((prev) =>
              prev ? { ...prev, description: '未能加载摘要预览', loading: false } : null,
            )
          }
        }
      }, 180)
    }

    const onPointerOver = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        'a.md-wikilink[data-wikilink-type][data-wikilink-slug]',
      )
      if (link && root.contains(link)) {
        openForLink(link)
      }
    }

    const onPointerOut = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        'a.md-wikilink[data-wikilink-type][data-wikilink-slug]',
      )
      if (link && root.contains(link)) {
        scheduleClose()
      }
    }

    const onFocusIn = (e: FocusEvent) => {
      const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        'a.md-wikilink[data-wikilink-type][data-wikilink-slug]',
      )
      if (link && root.contains(link)) {
        openForLink(link)
      }
    }

    const onFocusOut = (e: FocusEvent) => {
      const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        'a.md-wikilink[data-wikilink-type][data-wikilink-slug]',
      )
      if (link && root.contains(link)) {
        scheduleClose()
      }
    }

    const onCardEnter = () => window.clearTimeout(hideTimer)
    const onCardLeave = () => scheduleClose()
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeLink) {
        closeHovercard()
      }
    }

    root.addEventListener('mouseover', onPointerOver)
    root.addEventListener('mouseout', onPointerOut)
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)
    card.addEventListener('mouseenter', onCardEnter)
    card.addEventListener('mouseleave', onCardLeave)
    window.addEventListener('keydown', onEsc)

    return () => {
      clearTimers()
      closeHovercard()
      root.removeEventListener('mouseover', onPointerOver)
      root.removeEventListener('mouseout', onPointerOut)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
      card.removeEventListener('mouseenter', onCardEnter)
      card.removeEventListener('mouseleave', onCardLeave)
      window.removeEventListener('keydown', onEsc)
    }
  }, [queryClient, hovercardId, supportsAnchorPos])

  return (
    <>
      <div ref={containerRef}>
        <ProseContent html={renderedHtml} />
      </div>

      {/* Live announcement for copy action */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {copyStatusAnnouncement}
      </div>

      {/* Image Lightbox Modal */}
      <dialog
        ref={lightboxRef}
        closedby="any"
        aria-labelledby={lightboxCaptionId}
        className="editorial-lightbox"
      >
        {lightboxImage ? (
          <>
            <div className="flex items-center justify-between gap-4 px-2 pt-1">
              <p
                id={lightboxCaptionId}
                className="truncate text-sm font-medium text-[var(--text-secondary)]"
              >
                {lightboxImage.alt}
              </p>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                aria-label="关闭大图预览"
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex max-h-[82dvh] items-center justify-center overflow-auto rounded-lg bg-[var(--bg-canvas)] p-2">
              <img
                src={lightboxImage.src}
                alt={lightboxImage.alt}
                className="max-h-[78dvh] max-w-full rounded-md object-contain"
              />
            </div>
          </>
        ) : null}
      </dialog>

      {/* Wikilink Supplemental Preview Hovercard */}
      <div
        ref={hovercardRef}
        id={hovercardId}
        role="tooltip"
        className={`wikilink-hovercard ${supportsAnchorPos ? 'has-anchor-support' : ''}`}
        style={
          !supportsAnchorPos && fallbackCoords
            ? {
                position: 'fixed',
                top: `${fallbackCoords.top}px`,
                left: `${fallbackCoords.left}px`,
                margin: 0,
              }
            : undefined
        }
      >
        {hoverPreview ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 font-medium text-[var(--accent)]">
                {hoverPreview.typeLabel}
              </span>
              {hoverPreview.dateText ? <span>{hoverPreview.dateText}</span> : null}
            </div>
            <div className="text-sm font-bold leading-snug text-[var(--text-primary)]">
              {hoverPreview.title}
            </div>
            <p className="line-clamp-3 text-xs leading-relaxed text-[var(--text-secondary)]">
              {hoverPreview.loading ? '正在加载双链摘要...' : hoverPreview.description}
            </p>
            <div className="flex items-center justify-between pt-1 text-[11px] text-[var(--text-muted)]">
              <span>{hoverPreview.readingMinutes} 分钟阅读</span>
              <span className="inline-flex items-center gap-1 text-[var(--accent)]">
                点击正文链接跳转 <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
