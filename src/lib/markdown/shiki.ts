import type { Highlighter } from 'shiki'

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

  return createHighlighter({
    themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
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
