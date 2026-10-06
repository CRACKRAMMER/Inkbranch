'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * Theme control.
 *
 * Three states, not two: `system` is the default and is a real choice a reader
 * makes, so a binary toggle that silently resolves it to light or dark would
 * take that choice away. It is presented as a segmented control rather than a
 * dropdown because all three fit, and a menu for three items is a click for
 * nothing.
 *
 * The server has no idea which theme is active — it lives in `localStorage` —
 * so the control renders inert until mount. `useSyncExternalStore` reports
 * `false` on the server and `true` on the client, which is the hydration-safe
 * way to ask "am I mounted" without a `useEffect` and a second render.
 */

const OPTIONS = [
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
  { value: 'system', label: 'System theme', Icon: Monitor },
] as const

const neverChanges = () => () => undefined

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  )

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5',
        className,
      )}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }, index) => {
        // Before mount every option renders unselected: guessing would light up
        // the wrong one for a frame, and the CSS class is not yet applied.
        const active = mounted && theme === value

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            tabIndex={active || (!mounted && value === 'system') ? 0 : -1}
            title={label}
            onClick={() => setTheme(value)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % OPTIONS.length :
                event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + OPTIONS.length - 1) % OPTIONS.length :
                event.key === 'Home' ? 0 : event.key === 'End' ? OPTIONS.length - 1 : null
              if (next === null) return
              event.preventDefault()
              setTheme(OPTIONS[next]!.value)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
            }}
            className={cn(
              'inline-flex size-6 items-center justify-center rounded-sm transition-colors duration-150',
              active
                ? 'bg-surface text-ink shadow-raised'
                : 'text-ink-subtle hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
