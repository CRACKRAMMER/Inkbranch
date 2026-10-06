'use client'

import { useTheme } from 'next-themes'
import { useEffect } from 'react'

/**
 * The one client component the article body needs.
 *
 * Everything here is enhancement of markup the server already rendered: the
 * copy buttons exist in the HTML, the tab labels exist in the HTML, and the
 * Mermaid source exists in the HTML. With JavaScript disabled or still
 * loading, the reader gets a readable page — all tab panels visible, diagram
 * source as text — rather than blank boxes. That property is why the markup is
 * authored the way it is, and it is what this file must not break.
 *
 * It is a single component with one delegated listener per container rather
 * than a component per code block. A post with forty code blocks would
 * otherwise mount forty React roots to add forty event listeners, and the copy
 * button has no state worth a component: it flips one attribute for two
 * seconds.
 *
 * Mermaid is imported dynamically and only when a diagram is actually present.
 * A static import would put several hundred kilobytes of parser into the
 * bundle of every page on the site, including the ones with no diagrams.
 */

const COPY_RESET_MS = 2000

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

/** Counter for Mermaid's required unique element ids. */
let diagramSeq = 0

export function CodeEnhancer({
  contentKey,
  children,
  rootSelector = '[data-article-body]',
}: {
  /**
   * Identity of the rendered content. The effect re-runs when this changes,
   * which is what makes client-side navigation between two posts re-enhance
   * the new body — React reuses the component instance, so an empty dependency
   * list would leave the second post's code blocks dead.
   */
  contentKey: string
  children: React.ReactNode
  rootSelector?: string
}) {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(rootSelector)
    if (!root) return

    const cleanups: (() => void)[] = []

    cleanups.push(enhanceCopy(root))
    cleanups.push(enhanceTabs(root))

    let cancelled = false
    void enhanceDiagrams(root, resolvedTheme === 'dark' ? 'dark' : 'default', () => cancelled)

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [contentKey, resolvedTheme, rootSelector])

  return children
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

function enhanceCopy(root: HTMLElement): () => void {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  function onClick(event: MouseEvent) {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('.code-block__copy')
    if (!button || !root.contains(button)) return

    const figure = button.closest('.code-block')
    const code = figure?.querySelector('code')
    // `textContent`, not `innerText`: line numbers are painted by CSS
    // `content: attr(data-line)`, so they are not in the text at all, and
    // `innerText` would additionally apply text-transform and collapse
    // whitespace — both wrong for source code.
    const text = code?.textContent ?? ''

    void copyText(text).then((ok) => {
      if (!ok) return

      figure?.setAttribute('data-copied', 'true')

      const existing = timers.get(button)
      if (existing) clearTimeout(existing)

      timers.set(
        button,
        setTimeout(() => {
          figure?.removeAttribute('data-copied')
          timers.delete(button)
        }, COPY_RESET_MS),
      )
    })
  }

  root.addEventListener('click', onClick)

  return () => {
    root.removeEventListener('click', onClick)
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}

/**
 * Write text to the clipboard, reporting whether it worked.
 *
 * The async Clipboard API is only available in a secure context, so a site
 * served over plain HTTP on a LAN address — which a self-hosted blog often is —
 * has `navigator.clipboard` undefined. The textarea fallback is the deprecated
 * `execCommand`, which is nonetheless the only remaining mechanism there. It is
 * kept narrow: only reached when the modern path is unavailable, and removed
 * as soon as that stops being true.
 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or a non-focused document. Fall through rather than
      // giving up: the fallback has different failure modes.
    }
  }

  try {
    const scratch = document.createElement('textarea')
    scratch.value = text
    // Off-screen but still focusable — `display: none` cannot be selected.
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.top = '-9999px'
    scratch.setAttribute('aria-hidden', 'true')
    document.body.appendChild(scratch)
    scratch.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(scratch)
    return ok
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn the server-rendered tab markup into a working tablist.
 *
 * `data-enhanced` is the switch that lets the CSS start hiding panels. Until
 * this runs, every panel is visible — the whole point of doing it this way.
 *
 * The keyboard contract is the ARIA tabs pattern: arrows move between tabs,
 * Home and End jump to the ends, and only the selected tab is in the tab
 * order so Tab moves past the whole widget rather than through every tab.
 */
function enhanceTabs(root: HTMLElement): () => void {
  const widgets = root.querySelectorAll<HTMLElement>('.md-tabs')
  const cleanups: (() => void)[] = []

  for (const widget of widgets) {
    const tabs = Array.from(widget.querySelectorAll<HTMLButtonElement>('.md-tabs__tab'))
    const panels = Array.from(widget.querySelectorAll<HTMLElement>('.md-tab'))
    if (tabs.length === 0 || tabs.length !== panels.length) continue

    const select = (index: number) => {
      tabs.forEach((tab, i) => {
        const active = i === index
        tab.setAttribute('aria-selected', String(active))
        tab.tabIndex = active ? 0 : -1
      })
      panels.forEach((panel, i) => {
        panel.setAttribute('data-active', String(i === index))
      })
    }

    const panelId = (index: number) => `${tabs[index]?.id ?? `tab-${index}`}-panel`

    // Wire the ARIA relationship the static markup cannot know: the server
    // emits a stable `id` per tab and nothing else, because the panel ids have
    // to be unique across the whole document.
    tabs.forEach((tab, index) => {
      const panel = panels[index]
      if (!panel) return
      const id = panelId(index)
      panel.id = id
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-labelledby', tab.id)
      tab.setAttribute('aria-controls', id)
    })

    function onClick(event: MouseEvent) {
      const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('.md-tabs__tab')
      if (!tab) return
      const index = tabs.indexOf(tab as HTMLButtonElement)
      if (index >= 0) select(index)
    }

    function onKeyDown(event: KeyboardEvent) {
      const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('.md-tabs__tab')
      if (!tab) return

      const current = tabs.indexOf(tab as HTMLButtonElement)
      if (current < 0) return

      let next: number | null = null
      switch (event.key) {
        case 'ArrowRight':
          next = (current + 1) % tabs.length
          break
        case 'ArrowLeft':
          next = (current - 1 + tabs.length) % tabs.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = tabs.length - 1
          break
        default:
          return
      }

      event.preventDefault()
      select(next)
      tabs[next]?.focus()
    }

    widget.addEventListener('click', onClick)
    widget.addEventListener('keydown', onKeyDown)

    select(0)
    widget.setAttribute('data-enhanced', 'true')

    cleanups.push(() => {
      widget.removeEventListener('click', onClick)
      widget.removeEventListener('keydown', onKeyDown)
    })
  }

  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

/* -------------------------------------------------------------------------- */
/*  Mermaid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render every diagram on the page, loading the library on first need.
 *
 * Called again whenever the colour scheme changes, because a Mermaid theme is
 * baked into the SVG it produces at render time — it cannot be restyled by a
 * CSS variable the way a Shiki token can. The decoded source is therefore kept
 * on the element so a re-render does not have to re-read the attribute.
 */
async function enhanceDiagrams(
  root: HTMLElement,
  theme: 'dark' | 'default',
  isCancelled: () => boolean,
): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'))
  if (blocks.length === 0) return

  let mermaid: MermaidApi
  try {
    // Not named `module`: Next's lint rule forbids that identifier in a
    // client component, because bundlers rewrite it.
    const mermaidModule = (await import('mermaid')) as unknown as { default: MermaidApi }
    mermaid = mermaidModule.default
  } catch {
    // With scripting enabled, noscript contains no visible pre element.
    // Rebuild the readable source when the deferred library cannot load.
    if (!isCancelled()) {
      for (const block of blocks) {
        block.replaceChildren(fallbackSource(decodeSource(block)))
        block.setAttribute('data-error', 'true')
      }
    }
    return
  }

  if (isCancelled()) return

  mermaid.initialize({
    startOnLoad: false,
    theme,
    /*
     * `strict` is not negotiable. Diagram source is author-written Markdown,
     * but it is rendered as HTML into the page, and `loose` permits raw HTML
     * and click handlers inside a diagram — an XSS hole with a syntax for it.
     */
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: 'var(--font-sans)',
  })

  for (const block of blocks) {
    const source = decodeSource(block)
    if (!source) continue

    try {
      const { svg } = await mermaid.render(`mermaid-${(diagramSeq += 1)}`, source)
      if (isCancelled()) return

      block.innerHTML = svg
      // Lets the CSS size the result instead of Mermaid's inline max-width.
      block.setAttribute('data-processed', 'true')
    } catch {
      // A syntax error throws with a message written for the author. Printing
      // it would surface an internal diagnostic to a reader who cannot act on
      // it, so the diagram degrades to its source instead — which is what they
      // would have got with JavaScript off, and is still information.
      //
      // The source cannot simply be revealed: with scripting enabled the
      // browser parses `<noscript>`'s contents as a single text node, so there
      // is no `<pre>` in the tree to un-hide. It has to be rebuilt.
      block.replaceChildren(fallbackSource(source))
      block.setAttribute('data-error', 'true')
    }
  }
}

/** The readable stand-in for a diagram that could not be rendered. */
function fallbackSource(source: string): HTMLPreElement {
  const pre = document.createElement('pre')
  pre.className = 'mermaid-block__source'
  pre.textContent = source
  return pre
}

/**
 * Recover the diagram source from `data-mermaid`.
 *
 * The renderer base64-encodes it so that braces, quotes and angle brackets
 * survive the trip through an HTML attribute. `atob` yields latin1, so the
 * bytes are handed to `TextDecoder` to recover UTF-8 — labels in a diagram are
 * routinely non-ASCII, and decoding them as latin1 produces mojibake.
 *
 * Returns an empty string when the attribute is absent or corrupt; the caller
 * skips those rather than rendering an error.
 */
function decodeSource(block: HTMLElement): string {
  const encoded = block.dataset.mermaid
  if (!encoded) return ''

  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}
