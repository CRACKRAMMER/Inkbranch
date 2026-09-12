'use client'

import { Search } from 'lucide-react'
import { useCallback, useEffect, useState, type ComponentType } from 'react'

import { Kbd } from '@/components/ui/kbd'

/**
 * The search trigger, and the shortcut that does the same thing.
 *
 * What the reader sees is one button. What it opens — the dialog, the Radix
 * primitives underneath it, the result rows — is a separate module, imported
 * the first time somebody shows they want it. `command-palette-dialog.tsx`
 * carries the reasoning; this file is the part that has to be in the initial
 * bundle, so it is deliberately small enough to read in one screen.
 *
 * ## What counts as intent
 *
 * Opening it, obviously. But also hovering it, and focusing it by keyboard, and
 * pressing the shortcut — all of which happen a comfortable fraction of a second
 * before the palette is wanted, and all of which can start the download. That is
 * why the import is a plain function called from four places rather than a
 * `next/dynamic` boundary, which would only offer the moment the component
 * first renders: by then the reader is already waiting.
 *
 * The import is memoised, so the four callers share one request and the second
 * ⌘K costs nothing.
 */

type DialogComponent = ComponentType<{
  open: boolean
  onOpenChange: (open: boolean) => void
}>

let pending: Promise<{ CommandPaletteDialog: DialogComponent }> | null = null

function loadDialog(): Promise<{ CommandPaletteDialog: DialogComponent }> {
  pending ??= import('./command-palette-dialog').catch((error: unknown) => {
    // Do not cache a failed load: a reader whose connection dropped for a
    // moment should get a working palette on the next attempt rather than a
    // permanently dead button.
    pending = null
    throw error
  })
  return pending
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [Dialog, setDialog] = useState<DialogComponent | null>(null)

  /**
   * Start the download, and put the dialog on screen once it has arrived.
   *
   * `setDialog(() => module.CommandPaletteDialog)` and not
   * `setDialog(module.CommandPaletteDialog)`: React treats a function passed to
   * a state setter as an updater and would call the component instead of
   * storing it.
   */
  const reveal = useCallback(() => {
    void loadDialog().then(
      (module) => setDialog(() => module.CommandPaletteDialog),
      (error: unknown) => {
        console.error('[command-palette] failed to load:', error)
      },
    )
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        reveal()
        setOpen((was) => !was)
        return
      }
      // `/` opens the palette too, but not while the reader is typing into
      // something else — the same shorthand, and it must not steal a slash.
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, [contenteditable="true"]')) return
        event.preventDefault()
        reveal()
        setOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [reveal])

  return (
    <>
      <button
        type="button"
        onClick={() => {
          reveal()
          setOpen(true)
        }}
        // Intent, not commitment: both of these fire before a click does.
        onMouseEnter={reveal}
        onFocus={reveal}
        className="hidden h-8 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-xs text-ink-subtle transition-colors duration-150 hover:border-line-strong hover:text-ink-muted sm:inline-flex"
        aria-label="Search or run a command"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="pr-6">Search</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/*
        Mounted from the first load onward and never unmounted, so the query and
        the results survive a close and reopen. Rendering it only while `open`
        would reset both, which is a behaviour change and not this one.
      */}
      {Dialog ? <Dialog open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
