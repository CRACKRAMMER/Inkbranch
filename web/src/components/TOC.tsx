import { useEffect, useId, useRef, useState } from 'react'
import { ListTree, X } from 'lucide-react'
import { attachClosedByFallback } from '../lib/dialog'
import type { Heading } from '../lib/types'

interface TOCProps {
  headings: Heading[]
}

export function TOC({ headings }: TOCProps) {
  const [activeId, setActiveId] = useState<string>(headings[0]?.id ?? '')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDialogElement>(null)
  const drawerTitleId = useId()

  useEffect(() => {
    if (headings.length === 0) return
    setActiveId(headings[0]?.id ?? '')

    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]?.target.id) {
          setActiveId(visible[0].target.id)
        }
      },
      {
        rootMargin: '-84px 0px -65% 0px',
        threshold: [0, 1],
      },
    )

    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [headings])

  useEffect(() => {
    const dialog = drawerRef.current
    if (!dialog) return
    const onClose = () => setDrawerOpen(false)
    dialog.addEventListener('close', onClose)
    const cleanupFallback = attachClosedByFallback(dialog, () => setDrawerOpen(false))

    if (drawerOpen) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }

    return () => {
      dialog.removeEventListener('close', onClose)
      cleanupFallback()
    }
  }, [drawerOpen])

  if (headings.length === 0) return null

  const jumpToHeading = (id: string) => {
    setDrawerOpen(false)
    const target = document.getElementById(id)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveId(id)
      window.history.replaceState(null, '', `#${encodeURIComponent(id)}`)
    }
  }

  return (
    <>
      {/* Desktop Sticky Right-Rail TOC */}
      <nav
        aria-label="文章目录"
        className="hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] lg:block"
      >
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
          <ListTree className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
          <span>目录大纲</span>
        </div>
        <ul className="max-h-[48dvh] space-y-1 overflow-y-auto pr-1 text-xs">
          {headings.map((h) => {
            const isActive = activeId === h.id
            const indentClass =
              h.level >= 4 ? 'pl-6' : h.level === 3 ? 'pl-3.5' : 'pl-1.5'
            return (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    jumpToHeading(h.id)
                  }}
                  aria-current={isActive ? 'location' : undefined}
                  className={`block rounded-md border-l-2 py-1 pr-2 transition-colors ${indentClass} ${
                    isActive
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {h.text}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Mobile Floating TOC Trigger */}
      <div className="fixed right-4 bottom-5 z-30 lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="打开文章目录"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)]/95 px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] shadow-[var(--shadow-float)] backdrop-blur-md"
        >
          <ListTree className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
          <span>目录</span>
        </button>
      </div>

      {/* Mobile TOC Modal Dialog */}
      <dialog
        ref={drawerRef}
        closedby="any"
        aria-labelledby={drawerTitleId}
        className="editorial-dialog lg:hidden"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-3.5">
          <h2 id={drawerTitleId} className="text-sm font-semibold text-[var(--text-primary)]">
            文章目录
          </h2>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="关闭目录"
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <ul className="max-h-[65dvh] space-y-1 overflow-y-auto p-4 text-sm">
          {headings.map((h) => {
            const isActive = activeId === h.id
            const indentClass = h.level >= 4 ? 'pl-6' : h.level === 3 ? 'pl-3.5' : 'pl-2'
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => jumpToHeading(h.id)}
                  className={`w-full cursor-pointer rounded-lg py-2 pr-3 text-left ${indentClass} ${
                    isActive
                      ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]'
                  }`}
                >
                  {h.text}
                </button>
              </li>
            )
          })}
        </ul>
      </dialog>
    </>
  )
}
