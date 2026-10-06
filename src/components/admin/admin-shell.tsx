'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils/cn'
import { ADMIN_NAV, isCurrent } from './nav-items'

/**
 * The admin frame.
 *
 * Desktop is a fixed sidebar and a scrolling column of content. Below the
 * breakpoint the sidebar does not shrink or hide: it is replaced by a menu
 * button and a sheet, because a 44px-wide column of icons is not navigation.
 *
 * The column has no measure of its own — each page sets one. A list of tables
 * wants more room than a paragraph, and the Markdown editor wants as much as it
 * can get, so a single number here would be wrong for two of the three.
 */
export function AdminShell({
  user,
  signOut,
  children,
}: {
  user: { name: string; email: string; siteName: string }
  signOut: () => Promise<void>
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[15rem_1fr]">
        {/* Desktop sidebar */}
        <aside className="hidden border-r border-line lg:block">
          <div className="sticky top-0 flex h-dvh flex-col overflow-y-auto">
            <div className="border-b border-line px-5 py-5">
              <Link href="/admin" className="block">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
                  Admin
                </span>
                <span className="mt-1 block truncate font-serif text-base text-ink">
                  {user.siteName}
                </span>
              </Link>
            </div>
            <nav aria-label="Admin sections" className="flex-1 px-2 py-4">
              <NavList pathname={pathname} />
            </nav>
            <div className="border-t border-line px-5 py-4">
              <SignedInAs user={user} />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          {/* Top bar — the only chrome above content, on both breakpoints */}
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 lg:px-8">
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="lg:hidden">
                Menu
              </Button>
            </SheetTrigger>

            <p className="min-w-0 flex-1 truncate text-sm text-ink-muted">
              <span className="lg:hidden">{currentLabel(pathname)}</span>
              <span className="hidden lg:inline">{user.email}</span>
            </p>

            <ThemeToggle />
            <SignOutButton signOut={signOut} />
          </header>

          <main id="main" className="min-w-0 flex-1 px-4 py-8 lg:px-8 lg:py-10">
            {children}
          </main>
        </div>

        <SheetContent side="left" className="w-[17rem] p-0">
          <div className="border-b border-line px-5 py-5">
            <SheetTitle className="font-serif text-base">{user.siteName}</SheetTitle>
          </div>
          <nav aria-label="Admin sections" className="overflow-y-auto px-2 py-4">
            <NavList pathname={pathname} onNavigate={() => setMenuOpen(false)} />
          </nav>
          <div className="mt-auto border-t border-line px-5 py-4">
            <SignedInAs user={user} />
          </div>
        </SheetContent>
      </div>
    </Sheet>
  )
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-6">
      {ADMIN_NAV.map((group) => (
        <li key={group.label}>
          <p className="px-3 pb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
            {group.label}
          </p>
          <ul className="flex flex-col">
            {group.items.map((item) => {
              const current = isCurrent(item, pathname)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    onClick={onNavigate}
                    className={cn(
                      'block rounded-sm px-3 py-1.5 text-sm transition-colors',
                      current
                        ? 'bg-brand-quiet text-brand'
                        : 'text-ink-muted hover:bg-sunken hover:text-ink',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}

function SignedInAs({ user }: { user: { name: string; email: string } }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-ink">{user.name}</p>
      <p className="truncate text-xs text-ink-subtle">{user.email}</p>
    </div>
  )
}

function SignOutButton({ signOut }: { signOut: () => Promise<void> }) {
  return (
    <form action={signOut}>
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
    </form>
  )
}

function currentLabel(pathname: string): string {
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      if (isCurrent(item, pathname)) return item.label
    }
  }
  return 'Admin'
}
