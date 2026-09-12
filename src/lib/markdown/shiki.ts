import type { Highlighter, ThemeRegistration } from 'shiki'

import { makeContrastSafeTheme } from './theme-contrast'

/**
 * Shiki highlighter singleton.
 *
 * Highlighting happens entirely on the server, at render time. The client
 * receives pre-highlighted HTML with both palettes encoded as CSS custom
 * properties (`--shiki-light` / `--shiki-dark`), so switching themes is a CSS
 * class change — no highlighter, no grammars and no theme JSON on the client.
 *
 * The JavaScript regex engine is used instead of the WASM Oniguruma engine:
 * it starts an order of magnitude faster and avoids shipping a ~500 KB wasm
 * binary, at the cost of a few edge-case grammars.
 */

export const SHIKI_THEMES = {
  light: 'vitesse-light',
  dark: 'vitesse-dark',
} as const

/**
 * The pair of themes the highlighter is built with.
 *
 * Not the same values as `SHIKI_THEMES`, which names them. These are the theme
 * objects themselves, fetched from the bundle and rewritten so every foreground
 * is legible — `theme-contrast.ts` says what the editor palettes get wrong and
 * why the correction belongs here rather than in the stylesheet. Loaded once,
 * alongside the highlighter, because a theme is a few tens of kilobytes of JSON
 * and re-importing it per render would be pure waste.
 */
let themesPromise: Promise<{ light: ThemeRegistration; dark: ThemeRegistration }> | null =
  null

async function loadThemes(): Promise<{
  light: ThemeRegistration
  dark: ThemeRegistration
}> {
  const { bundledThemes } = await import('shiki/themes')

  const [light, dark] = await Promise.all([
    bundledThemes[SHIKI_THEMES.light](),
    bundledThemes[SHIKI_THEMES.dark](),
  ])

  return {
    light: makeContrastSafeTheme(light.default),
    dark: makeContrastSafeTheme(dark.default),
  }
}

export function getThemes(): Promise<{
  light: ThemeRegistration
  dark: ThemeRegistration
}> {
  themesPromise ??= loadThemes().catch((error: unknown) => {
    themesPromise = null
    throw error
  })
  return themesPromise
}

/** Languages loaded eagerly. Everything else is loaded on demand. */
const EAGER_LANGUAGES = [
  'bash',
  'shell',
  'zsh',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'dockerfile',
  'nginx',
  'sql',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'css',
  'scss',
  'html',
  'xml',
  'markdown',
  'diff',
  'makefile',
  'graphql',
  'http',
  'lua',
  'ruby',
  'php',
] as const

/** Aliases so ```sh``` and ```console``` do not each load a grammar. */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash',
  console: 'bash',
  terminal: 'bash',
  shellsession: 'bash',
  docker: 'dockerfile',
  yml: 'yaml',
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  make: 'makefile',
  md: 'markdown',
  svg: 'xml',
  htm: 'html',
  postgres: 'sql',
  psql: 'sql',
  mysql: 'sql',
  kt: 'kotlin',
  cs: 'csharp',
  pas: 'pascal',
  terraform: 'hcl',
  tf: 'hcl',
}

/** Languages shiki knows about, cached after the first load. */
let knownLanguages: Set<string> | null = null

let highlighterPromise: Promise<Highlighter> | null = null

async function createHighlighterInstance(): Promise<Highlighter> {
  const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki')

  const themes = await getThemes()

  return createHighlighter({
    themes: [themes.light, themes.dark],
    langs: [...EAGER_LANGUAGES],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
}

export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighterInstance().catch((error: unknown) => {
    // Do not cache a failed initialisation; the next render should retry.
    highlighterPromise = null
    throw error
  })
  return highlighterPromise
}

/**
 * Map a fence label onto a grammar shiki actually has.
 * Returns `null` when there is no match, so the caller can fall back to plain
 * text rather than throwing on ` ```foobar `.
 */
export async function resolveLanguage(
  raw: string | undefined,
): Promise<string | null> {
  if (!raw) return null

  const normalised = raw.trim().toLowerCase()
  if (!normalised) return null

  const highlighter = await getHighlighter()
  knownLanguages ??= new Set(highlighter.getLoadedLanguages())

  const candidate = LANGUAGE_ALIASES[normalised] ?? normalised

  if (knownLanguages.has(candidate)) return candidate

  // Load it lazily. Some corpora use ```vue or ```elixir; failing the whole
  // page render over a fence label would be a poor trade.
  try {
    await highlighter.loadLanguage(
      candidate as Parameters<Highlighter['loadLanguage']>[0],
    )
    knownLanguages.add(candidate)
    return candidate
  } catch {
    return null
  }
}

/** Warm the highlighter. Called once from the boot sequence. */
export async function warmHighlighter(): Promise<void> {
  try {
    await getHighlighter()
  } catch (error) {
    console.error('[shiki] warm-up failed:', error)
  }
}
