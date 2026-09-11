'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FileText, Hash, Loader2, Search, Terminal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Kbd } from '@/components/ui/kbd'
import type { ContentType } from '@/lib/db/schema'
import { groupHits } from '@/lib/search/group'
import { cn } from '@/lib/utils/cn'

/**
 * The command palette.
 *
 * One input with two modes, distinguished by a single character. A leading `>`
 * means "do something"; anything else means "find something". This is the
 * convention a reader already knows from other tools, and it avoids a second
 * shortcut, a second overlay, and a mode switch that has to be discovered.
 *
 * Why not `cmdk`: it is a fine library, but it ships its own filtering, its own
 * dialog and its own keyboard model, and here the filtering has to be a server
 * round trip against the same ranked index the search page uses. Keeping the
 * ranking in one place matters more than saving the listbox wiring, which is
 * about eighty lines.
 *
 * ## Results are grouped by kind
 *
 * Articles, then Notes, then Projects — the site's own order rather than the
 * ranking's. The ranking still decides the order *within* a group; what it no
 * longer decides is which kind of thing a reader meets first, because someone
 * who types `linux` into a launcher is as likely to be looking for a kind of
 * document as for a particular one. `groupHits` is where the rule lives, and
 * the row that no longer repeats "Article" beside every article says the
 * document's category instead.
 *
 * Accessibility follows the ARIA combobox pattern: focus stays in the input the
 * whole time and the active option is named by `aria-activedescendant`. Moving
 * DOM focus into the list would break typing, which is the one thing the reader
 * is certainly doing.
 */

const DEBOUNCE_MS = 150
const RESULT_LIMIT = 8

/**
 * A shared empty array for the "no results" case.
 *
 * A fresh `[]` literal would be a new identity on every render, which makes any
 * `useMemo` depending on it recompute every time and any `useEffect` re-run —
 * the classic way a component ends up doing full work per keystroke.
 */
const NO_HITS: Hit[] = []

interface Hit {
  type: ContentType
  slug: string
  url: string
  title: string
  /** Title with `<mark>` around matches. Escaped by the server. */
  titleHtml: string
  description: string
  /** The section the document is filed under, when it has one. */
  category: string | null
}

interface Command {
  id: string
  label: string
  hint: string
  /** Extra strings the query is matched against, so `>theme` finds all three. */
  keywords: string[]
  run: (context: { setTheme: (theme: string) => void; router: ReturnType<typeof useRouter> }) => void
}

type PaletteItem =
  | { kind: 'command'; command: Command }
  | { kind: 'hit'; hit: Hit }

/** Rows under one heading, with where they start in the flat list. */
interface PaletteSection {
  key: string
  label: string
  /**
   * The index of this section's first row in the flat list.
   *
   * Carried rather than re-counted while rendering, because the two have to
   * agree: the highlight is an index into the flat list and `aria-activedescendant`
   * is built from it, so a section that counted its own rows incorrectly would
   * highlight one row and announce another.
   */
  start: number
  items: PaletteItem[]
}

/**
 * The commands, as a plain array.
 *
 * Built here rather than memoised inside the component because none of them
 * close over component state — everything they need arrives in the context
 * argument. A list that never needs rebuilding should not be rebuilt on every
 * keystroke.
 */
const COMMANDS: Command[] = [
  {
    id: 'theme:light',
    label: 'Theme: light',
    hint: 'Switch the palette',
    keywords: ['theme', 'light', 'appearance', 'colour'],
    run: ({ setTheme }) => setTheme('light'),
  },
  {
    id: 'theme:dark',
    label: 'Theme: dark',
    hint: 'Switch the palette',
    keywords: ['theme', 'dark', 'appearance', 'colour'],
    run: ({ setTheme }) => setTheme('dark'),
  },
  {
    id: 'theme:system',
    label: 'Theme: follow system',
    hint: 'Switch the palette',
    keywords: ['theme', 'system', 'auto', 'appearance', 'colour'],
    run: ({ setTheme }) => setTheme('system'),
  },
  {
    id: 'admin',
    label: 'Open admin',
    hint: 'Manage content',
    keywords: ['admin', 'manage', 'dashboard', 'cms', 'write'],
    run: ({ router }) => router.push('/admin'),
  },
  {
    id: 'rss',
    label: 'Copy RSS URL',
    hint: 'To the clipboard',
    keywords: ['rss', 'feed', 'subscribe', 'atom'],
    run: () => {
      const url = `${window.location.origin}/rss.xml`
      void navigator.clipboard
        .writeText(url)
        .then(() => toast.success('RSS URL copied', { description: url }))
        .catch(() => toast.error('Could not copy', { description: url }))
    },
  },
]

/** Matches an option against the query. Every whitespace-separated term must land. */
function matches(terms: string[], label: string, keywords: string[]): boolean {
  const haystack = label.toLowerCase()
  return terms.every(
    (term) =>
      haystack.includes(term) || keywords.some((keyword) => keyword.startsWith(term)),
  )
}

export function CommandPalette() {
  const router = useRouter()
  const { setTheme } = useTheme()
  const listboxId = useId()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * The last answer the server gave, tagged with the query it answers.
   *
   * `searching` is deliberately *not* state. It is exactly "the answer I hold
   * is not for what is typed", which is a comparison, not a fact to store — and
   * storing it meant an effect whose only job was to write `false` when the
   * fetch was skipped, which is the cascading render the lint rule exists to
   * catch. Deriving it also removes the window where a fetch resolved but the
   * flag had not flipped yet.
   */
  const [response, setResponse] = useState<{
    forQuery: string
    hits: Hit[]
    notice: string | null
  }>({ forQuery: '', hits: [], notice: null })
  const [active, setActive] = useState(0)

  const listRef = useRef<HTMLDivElement>(null)

  const trimmed = query.trim()
  const isCommandMode = query.startsWith('>')

  const searching = !isCommandMode && trimmed !== '' && response.forQuery !== trimmed
  // Stale results are dropped rather than shown while the next request is in
  // flight: in a launcher the reader is typing *at* the list, and a row that
  // survives a keystroke it no longer matches is a row that gets clicked by
  // mistake.
  const settled = response.forQuery === trimmed
  const hits = isCommandMode || !settled ? NO_HITS : response.hits
  const notice = isCommandMode || !settled ? null : response.notice
  const commandTerms = useMemo(
    () =>
      query
        .slice(1)
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    [query],
  )

  const visibleCommands = useMemo(
    () => (isCommandMode ? COMMANDS.filter((c) => matches(commandTerms, c.label, c.keywords)) : []),
    [isCommandMode, commandTerms],
  )

  /**
   * The rows, under their headings.
   *
   * Sections rather than one list, because the grouping is what tells a reader
   * that the third result is a note and not a shorter article. The flat list
   * below is derived from this one and not built beside it, so the keyboard, the
   * highlight and the rendered order cannot disagree about which row is which.
   */
  const sections = useMemo((): PaletteSection[] => {
    const built: PaletteSection[] = []
    let start = 0

    if (isCommandMode) {
      if (visibleCommands.length > 0) {
        built.push({
          key: 'commands',
          label: 'Commands',
          start,
          items: visibleCommands.map((command) => ({ kind: 'command' as const, command })),
        })
      }
      return built
    }

    for (const group of groupHits(hits)) {
      built.push({
        key: group.type,
        label: group.label,
        start,
        items: group.hits.map((hit) => ({ kind: 'hit' as const, hit })),
      })
      start += group.hits.length
    }

    return built
  }, [isCommandMode, visibleCommands, hits])

  /** The display order, flattened. What the arrow keys move through. */
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections])

  /* ---------------------------------------------------------------- global key */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((was) => !was)
        return
      }
      // `/` opens the palette too, but not while the reader is typing into
      // something else — the same shorthand, and it must not steal a slash.
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, [contenteditable="true"]')) return
        event.preventDefault()
        setOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ------------------------------------------------------------------- search */

  useEffect(() => {
    // Command mode is answered from the local list, so no request is made.
    if (!open || isCommandMode || !trimmed) return

    const controller = new AbortController()

    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=${RESULT_LIMIT}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
        .then(async (result) => {
          if (!result.ok) throw new Error(`search responded ${result.status}`)
          return (await result.json()) as { hits: Hit[]; notice?: string }
        })
        .then((data) => {
          setResponse({ forQuery: trimmed, hits: data.hits ?? [], notice: data.notice ?? null })
        })
        .catch((error: unknown) => {
          // An abort is the expected outcome of typing another character, not a
          // failure to report.
          if (error instanceof DOMException && error.name === 'AbortError') return
          setResponse({
            forQuery: trimmed,
            hits: [],
            notice: 'Search is unavailable right now.',
          })
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, trimmed, isCommandMode])

  /* ------------------------------------------------------------------ keyboard */

  /*
   * Reset the highlight when the list underneath it changes.
   *
   * Done during render, not in an effect. React's documented rule is that state
   * can be adjusted while rendering as long as it is guarded by a comparison
   * against the value that caused it — which this is — and the payoff is that
   * the reader never sees a frame where the old index is highlighted against
   * the new list. An effect would run after paint, so that frame is visible.
   */
  const listKey = `${isCommandMode ? 'cmd' : 'q'}:${query}`
  const [activeKey, setActiveKey] = useState(listKey)
  if (activeKey !== listKey) {
    setActiveKey(listKey)
    setActive(0)
  }

  // Keep the highlighted row in view when the keyboard moves past the fold.
  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    option?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = useCallback(
    (index: number) => {
      const item = items[index]
      if (!item) return

      if (item.kind === 'command') {
        item.command.run({ setTheme, router })
        // The theme commands should not dismiss — a reader trying both themes
        // would otherwise have to reopen the palette each time.
        if (!item.command.id.startsWith('theme:')) setOpen(false)
        return
      }

      setOpen(false)
      router.push(item.hit.url)
    },
    [items, router, setTheme],
  )

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((current) => (items.length === 0 ? 0 : (current + 1) % items.length))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((current) =>
          items.length === 0 ? 0 : (current - 1 + items.length) % items.length,
        )
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(Math.max(0, items.length - 1))
        break
      case 'Enter':
        event.preventDefault()
        choose(active)
        break
      default:
        break
    }
  }

  const activeId = items.length > 0 ? `${listboxId}-option-${active}` : undefined

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-8 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-xs text-ink-subtle transition-colors duration-150 hover:border-line-strong hover:text-ink-muted sm:inline-flex"
        aria-label="Search or run a command"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="pr-6">Search</span>
        <Kbd>⌘K</Kbd>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <DialogPrimitive.Content
            // Escapes the shared `DialogContent` styling on purpose: this is a
            // launch bar at the top of the screen, not a modal card in the
            // middle, and it must not shift position as results arrive.
            className="fixed left-1/2 top-[12vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-float"
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">
              Search and commands
            </DialogPrimitive.Title>

            <div className="flex items-center gap-2.5 border-b border-line px-3.5">
              {isCommandMode ? (
                <Terminal className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              ) : (
                <Search className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              )}
              <input
                // Radix focuses the first focusable child, but the intent is
                // explicit and costs one attribute.
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search, or type > for commands"
                aria-label="Search or run a command"
                role="combobox"
                aria-expanded
                aria-controls={listboxId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                className="h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
              />
              {searching ? (
                <Loader2
                  className="size-3.5 shrink-0 animate-spin text-ink-subtle motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
            </div>

            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={isCommandMode ? 'Commands' : 'Results'}
              className="max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain p-1.5"
            >
              {sections.map((section) => (
                /*
                  A group inside the listbox, named by the heading beside it.
                  The heading itself is `aria-hidden`, and that is not a way of
                  hiding it from anyone: the group already carries the same word
                  as its name, so a screen reader announces "Articles, group"
                  once rather than reading the word twice. It stays in the DOM,
                  and on screen, for the reader who is scanning with their eyes.
                */
                <div key={section.key} role="group" aria-label={section.label}>
                  <div
                    aria-hidden="true"
                    className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-subtle"
                  >
                    {section.label}
                  </div>

                  {section.items.map((item, offset) => {
                    const index = section.start + offset
                    return (
                      <Option
                        key={
                          item.kind === 'command'
                            ? item.command.id
                            : `${item.hit.type}:${item.hit.slug}`
                        }
                        id={`${listboxId}-option-${index}`}
                        index={index}
                        selected={index === active}
                        onHover={() => setActive(index)}
                        onChoose={() => choose(index)}
                      >
                        {item.kind === 'command' ? (
                          <CommandRow command={item.command} />
                        ) : (
                          <HitRow hit={item.hit} />
                        )}
                      </Option>
                    )
                  })}
                </div>
              ))}

              {items.length === 0 ? <EmptyState query={query} commandMode={isCommandMode} /> : null}
            </div>

            <div className="flex items-center gap-4 border-t border-line px-3.5 py-2 text-xs text-ink-subtle">
              <Hint keys="↑↓" label="Navigate" />
              <Hint keys="↵" label="Select" />
              <Hint keys="esc" label="Close" />
              {notice ? <span className="ml-auto text-warning">{notice}</span> : null}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}

/* ---------------------------------------------------------------------------- */
/*  Rows                                                                        */
/* ---------------------------------------------------------------------------- */

function Option({
  id,
  index,
  selected,
  onHover,
  onChoose,
  children,
}: {
  id: string
  index: number
  selected: boolean
  onHover: () => void
  onChoose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      // Pointer events, not click: `onMouseDown` would fire before the input
      // blurs, and a click on a result must not also be read as a dismissal.
      onMouseMove={onHover}
      onClick={onChoose}
      className={cn(
        'flex cursor-default items-center gap-3 rounded-md px-2.5 py-2 text-sm',
        selected ? 'bg-sunken text-ink' : 'text-ink-muted',
      )}
    >
      {children}
    </div>
  )
}

function CommandRow({ command }: { command: Command }) {
  return (
    <>
      <Terminal className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      <span className="truncate text-ink">{command.label}</span>
      <span className="ml-auto shrink-0 text-xs text-ink-subtle">{command.hint}</span>
    </>
  )
}

/**
 * One result.
 *
 * The row no longer says what kind of thing it is — the heading above it does,
 * and a label that repeats the heading in every row is a label nobody reads.
 * What is said instead is the document's category, when it has one: the heading
 * tells the reader the shape of the result, and this tells them the shelf.
 */
function HitRow({ hit }: { hit: Hit }) {
  return (
    <>
      {hit.type === 'note' ? (
        <Hash className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      ) : (
        <FileText className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        {/*
          `titleHtml` comes from the local provider's `highlight()`, which
          escapes the text and then wraps matches in `<mark>`. It is the only
          HTML injected here; `description` is rendered as text.
        */}
        <span
          className="block truncate text-ink [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-brand"
          dangerouslySetInnerHTML={{ __html: hit.titleHtml }}
        />
        {hit.description ? (
          <span className="block truncate text-xs text-ink-subtle">{hit.description}</span>
        ) : null}
      </span>
      {hit.category ? (
        <span className="shrink-0 text-xs text-ink-subtle">{hit.category}</span>
      ) : null}
    </>
  )
}

function EmptyState({ query, commandMode }: { query: string; commandMode: boolean }) {
  const trimmed = query.trim()

  return (
    <p className="px-3 py-8 text-center text-sm text-ink-subtle">
      {!trimmed
        ? 'Type to search. Start with > to run a command.'
        : commandMode
          ? `No command matches “${trimmed}”.`
          : `Nothing found for “${trimmed}”.`}
    </p>
  )
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Kbd>{keys}</Kbd>
      <span>{label}</span>
    </span>
  )
}
