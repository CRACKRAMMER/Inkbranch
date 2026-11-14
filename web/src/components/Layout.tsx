import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Menu, Monitor, Moon, Rss, Search, Sparkles, Sun, X } from 'lucide-react'
import { attachClosedByFallback } from '../lib/dialog'
import { getInitialSiteInfo } from '../lib/preload'
import { getThemeMode, setThemeMode, type ThemeMode } from '../lib/theme'
import { CommandPalette } from './CommandPalette'
import { NewsletterBox } from './NewsletterBox'

const NAV_ITEMS = [
  { to: '/', label: '首页', matchExact: true },
  { to: '/posts', label: '长文' },
  { to: '/notes', label: '随笔' },
  { to: '/projects', label: '项目' },
  { to: '/series', label: '专栏' },
  { to: '/graph', label: '图谱' },
  { to: '/archive', label: '归档' },
  { to: '/friends', label: '友链' },
] as const

export function Layout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/')
  const site = getInitialSiteInfo()

  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode())
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const mobileDialogRef = useRef<HTMLDialogElement>(null)
  const mobileMenuTitleId = useId()

  useEffect(() => {
    const dialog = mobileDialogRef.current
    if (!dialog) return
    const onClose = () => setMobileMenuOpen(false)
    dialog.addEventListener('close', onClose)
    const cleanup = attachClosedByFallback(dialog, () => setMobileMenuOpen(false))

    if (mobileMenuOpen) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }

    return () => {
      dialog.removeEventListener('close', onClose)
      cleanup()
    }
  }, [mobileMenuOpen])

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  const cycleTheme = () => {
    const next: ThemeMode =
      theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'
    setTheme(next)
    setThemeMode(next)
  }

  const isCurrent = (to: string, matchExact?: boolean) => {
    if (matchExact) return pathname === '/'
    return pathname === to || pathname.startsWith(`${to}/`)
  }

  const themeLabel =
    theme === 'dark' ? '深色模式（点击切换）' : theme === 'light' ? '浅色模式（点击切换）' : '跟随系统（点击切换）'

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <a href="#main-content" className="skip-link visually-hidden">
        跳至正文内容
      </a>

      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/82 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="group inline-flex items-center gap-2.5 text-base font-bold tracking-tight text-[var(--text-primary)]"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--accent)] font-serif text-sm font-bold text-[var(--accent-ink)] shadow-sm transition-transform group-hover:scale-105"
              >
                墨
              </span>
              <span>{site.name}</span>
            </Link>
          </div>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const active = isCurrent(item.to, 'matchExact' in item ? item.matchExact : false)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className="nav-link"
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCmdkOpen(true)}
              aria-label="打开全站搜索命令面板"
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <Search className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
              <span className="hidden sm:inline">搜索</span>
              <kbd className="kbd-chip hidden sm:inline-flex">⌘K</kbd>
            </button>

            <a
              href="/feed.xml"
              aria-label="RSS 订阅源"
              title="RSS 2.0 订阅源"
              className="hidden h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--accent)] sm:inline-flex"
            >
              <Rss className="h-4 w-4" aria-hidden="true" />
            </a>

            <button
              type="button"
              onClick={cycleTheme}
              aria-label={themeLabel}
              title={themeLabel}
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              {theme === 'dark' ? (
                <Moon className="h-4 w-4" aria-hidden="true" />
              ) : theme === 'light' ? (
                <Sun className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Monitor className="h-4 w-4" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="打开导航菜单"
              aria-expanded={mobileMenuOpen}
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] md:hidden"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className={`mx-auto w-full flex-1 px-4 py-8 sm:px-6 sm:py-10 ${isAdminRoute ? 'max-w-7xl' : 'max-w-6xl'}`}
      >
        {children}
      </main>

      {!isAdminRoute && (
        <footer className="mt-16 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/70">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-10 sm:px-6 lg:grid-cols-12">
            <div className="space-y-3 lg:col-span-5">
              <div className="flex items-center gap-2 font-bold text-[var(--text-primary)]">
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] font-serif text-xs font-bold text-[var(--accent-ink)]"
                >
                  墨
                </span>
                <span>{site.name}</span>
              </div>
              <p className="max-w-md text-sm text-[var(--text-secondary)]">
                {site.description}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--text-muted)]">
                <a href="/feed.xml" className="hover:text-[var(--accent)]">
                  RSS 2.0
                </a>
                <a href="/atom.xml" className="hover:text-[var(--accent)]">
                  Atom 1.0
                </a>
                <a href="/feed.json" className="hover:text-[var(--accent)]">
                  JSON Feed
                </a>
                <a href="/llms.txt" className="inline-flex items-center gap-1 hover:text-[var(--accent)]">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  llms.txt
                </a>
                <a href="/sitemap.xml" className="hover:text-[var(--accent)]">
                  Sitemap
                </a>
                <Link to="/tags" className="hover:text-[var(--accent)]">
                  全部标签
                </Link>
                <Link to="/admin" className="hover:text-[var(--accent)]">
                  Studio
                </Link>
              </div>
            </div>

            <div className="lg:col-span-7">
              <NewsletterBox compact />
            </div>
          </div>
        </footer>
      )}

      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />

      {/* Mobile Navigation Modal */}
      <dialog
        ref={mobileDialogRef}
        closedby="any"
        aria-labelledby={mobileMenuTitleId}
        className="editorial-dialog md:hidden"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-3.5">
          <h2 id={mobileMenuTitleId} className="text-sm font-semibold text-[var(--text-primary)]">
            站点导航
          </h2>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="关闭导航菜单"
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Mobile" className="grid grid-cols-2 gap-2 p-4">
          {NAV_ITEMS.map((item) => {
            const active = isCurrent(item.to, 'matchExact' in item ? item.matchExact : false)
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className={`rounded-xl border px-3.5 py-2.5 text-sm font-medium ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
          <Link
            to="/tags"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5 text-sm font-medium text-[var(--text-primary)]"
          >
            标签索引
          </Link>
          <Link
            to="/search"
            search={{ q: '' }}
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5 text-sm font-medium text-[var(--text-primary)]"
          >
            全站搜索
          </Link>
        </nav>
      </dialog>
    </div>
  )
}
