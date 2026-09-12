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
 * How long shiki may spend tokenising a single line, in milliseconds.
 *
 * Shiki's default is 500 ms, and it is not a soft target: when the budget runs
 * out, vscode-textmate stops scanning mid-line and returns the tokens it has as
 * though they were the whole line. Here that is not a slow render but a wrong
 * one — the truncated line reaches the dual-theme merge as a single token, so
 * the first token's colour is spread across the rest of it.
 *
 * The budget is spent by the *first* tokenisation in a process, which pays for
 * compiling every grammar pattern to a JavaScript `RegExp`; the same line costs
 * a few milliseconds from then on. Measured through the app's own path on one
 * machine, a single TypeScript line in a cold process:
 *
 *   idle machine               216 ms
 *   with the unit suite running 404 ms, 476 ms, 638 ms
 *
 * Against a 500 ms default that is not a margin. The 638 ms run is also the run
 * in which `theme-contrast.test.ts` failed with the smeared palette, and the
 * runs under 500 ms are the ones in which it passed — which is how this was
 * found: a test failing at random once in every few runs on a tree where
 * nothing was wrong. Under this limit, four further cold renders measured 543,
 * 578, 665 and 800 ms — every one of them past the old cliff — and all four
 * rendered correctly.
 *
 * Raised rather than removed. A fence that genuinely costs five seconds a line
 * is pathological, and the honest answer to a pathological one is a slow render
 * rather than an unbounded one; but the difference between the two is not a
 * cliff a cold process falls off. The other way to spend this is to warm the
 * first tokenisation at boot, which costs 4 s of CPU and a window of slow
 * responses after every restart — `warmHighlighter` records that measurement
 * and why it was not bought.
 */
export const TOKENIZE_TIME_LIMIT = 5_000

type Themes = { light: ThemeRegistration; dark: ThemeRegistration }

/**
 * The one-per-process caches, kept on `globalThis` rather than in module scope.
 *
 * Module scope is per *bundle*, and Next bundles the instrumentation hook
 * separately from the route handlers: `server/instrumentation.js` is a thin
 * loader for its own chunk, with its own module registry. A module-level `let`
 * is therefore two variables in one process, and warming one has no effect on
 * the other.
 *
 * That is not a theory. With a trace on `createHighlighterInstance`, a single
 * `next start` logged `[shiki] building` twice under one PID — once at boot
 * from `instrumentation.ts`, once on the first fenced code block — and the
 * request that paid for the second took 603 ms against 48 ms for the same page
 * immediately after. The warm-up was working perfectly and doing nothing.
 *
 * `globalThis` is the only scope the two bundles share, so the cache lives
 * there. One namespaced key, one typed shape, and the accessors below are still
 * the only way in.
 */
interface ShikiCache {
  themes: Promise<Themes> | null
  highlighter: Promise<Highlighter> | null
  knownLanguages: Set<string> | null
}

const globalShiki = globalThis as typeof globalThis & {
  __myblogShikiCache?: ShikiCache
}

const cache: ShikiCache = (globalShiki.__myblogShikiCache ??= {
  themes: null,
  highlighter: null,
  knownLanguages: null,
})

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
async function loadThemes(): Promise<Themes> {
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

/**
 * A theme with its own arrays and settings objects, for handing to a library
 * that writes into them.
 *
 * Structural rather than `structuredClone`, because the two shapes shiki
 * touches are known and a structural copy cannot throw on some future value the
 * theme format is not supposed to carry. What it must cover is what was
 * measured: the `tokenColors` array and the `settings` object of its entries.
 */
function copyTheme(theme: ThemeRegistration): ThemeRegistration {
  return {
    ...theme,
    colors: theme.colors ? { ...theme.colors } : theme.colors,
    tokenColors: theme.tokenColors?.map((token) => ({
      ...token,
      settings: token.settings ? { ...token.settings } : token.settings,
    })),
  }
}

/**
 * The pair of themes the highlighter is built with — the cached pair, copied.
 *
 * The copy is not defensive habit; shiki writes into the object it is handed.
 * One `createHighlighter` over `vitesse-light`, measured rather than assumed,
 * takes `tokenColors` from 56 entries to 57 and rewrites the first: the entry
 * scoped to `comment` comes back with no scope at all and carrying the editor's
 * own colours. `normalizeTheme` is what does it — it renames `tokenColors` to
 * `settings`, keeps the *same array*, and unshifts a default entry into it — and
 * it runs again on every call, because the marker it leaves behind to make
 * itself idempotent is non-enumerable and lands on a shallow copy rather than
 * on the theme the caller passed.
 *
 * Every caller here hands the result straight to shiki, so without the copy the
 * cache is a value that one consumer writes and the next one reads — in a
 * process where `instrumentation.ts` warms a highlighter at boot while requests
 * build another, and where the cache has to live on `globalThis` because two
 * Next bundles share it.
 *
 * This is *not* why `theme-contrast.test.ts` used to fail at random; that was
 * `TOKENIZE_TIME_LIMIT`, and it says what it was. This is the defect found while
 * chasing it: the cache is shared mutable state, and shiki demonstrably edits
 * it. Guarded by the test that asserts the pair comes back a copy.
 */
export async function getThemes(): Promise<Themes> {
  cache.themes ??= loadThemes().catch((error: unknown) => {
    cache.themes = null
    throw error
  })

  const themes = await cache.themes
  return { light: copyTheme(themes.light), dark: copyTheme(themes.dark) }
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
  cache.highlighter ??= createHighlighterInstance().catch((error: unknown) => {
    // Do not cache a failed initialisation; the next render should retry.
    cache.highlighter = null
    throw error
  })
  return cache.highlighter
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
  // Languages shiki knows about, cached after the first load.
  const known = (cache.knownLanguages ??= new Set(highlighter.getLoadedLanguages()))

  const candidate = LANGUAGE_ALIASES[normalised] ?? normalised

  if (known.has(candidate)) return candidate

  // Load it lazily. Some corpora use ```vue or ```elixir; failing the whole
  // page render over a fence label would be a poor trade.
  try {
    await highlighter.loadLanguage(
      candidate as Parameters<Highlighter['loadLanguage']>[0],
    )
    known.add(candidate)
    return candidate
  } catch {
    return null
  }
}

/*
 * What warming the highlighter does and does not do, and what was measured.
 *
 * `warmHighlighter` builds the highlighter and its themes. It does not tokenise
 * anything, and that is a decision made against measurements rather than a gap
 * left by accident.
 *
 * Shiki converts a grammar's Oniguruma patterns to JavaScript `RegExp` lazily,
 * when a *scanner* for that grammar is first constructed — which happens the
 * first time tokenisation enters that grammar, including the grammars injected
 * into it (the stylesheet injection into JavaScript and TypeScript template
 * literals, for one). The engine memoises each conversion by pattern string, so
 * from then on it is free. All of it happens without a text sample: a
 * `codeToHast` call is what builds the scanner.
 *
 * So the cost of a cold process is split in two, and they were measured apart
 * on a standalone build, one request to `/posts/atomic-writes` (three TypeScript
 * fences), cold server, against 34 ms for the same page immediately afterwards:
 *
 *   building the highlighter and themes   ~270 ms   ← warmed here
 *   the first tokenisation                ~300 ms   ← deliberately not warmed
 *
 * Warming the second half works. Driving a 40-line sample through every eager
 * language at boot brought the first fence from 210 ms to 6 ms. It also cost
 * 4 s of CPU, and — the part that decided it — requests arriving *during* that
 * 4 s waited for it: `/tags`, a route that renders no code at all, took 4.6 s
 * where it normally takes 15 ms. Yielding to the event loop between languages
 * did not help, because the server is listening from ~400 ms while `register`
 * is still running, so the window is exactly the one a warm-up opens.
 *
 * The sweep, for whoever revisits this. Cold render, one build each:
 *
 *   a one-character sample                1.2 s boot, first fence 208 ms
 *   that sample repeated 60 times         3.4 s boot, first fence 210 ms
 *   representative TypeScript             1.9 s boot, first fence 223 ms
 *   ...plus classes and control flow      2.0 s boot, first fence 205 ms
 *   ...plus shell, SQL, HTML and CSS      4.0 s boot, first fence   6 ms
 *
 * Repetition buys nothing; the same patterns converted once are cached.
 * Narrowing the last group was tried four ways — plain CSS, CSS inside a
 * template literal, a JSX tag, and each of the four separately — and every one
 * landed back at ~220 ms. Only the full group works, and why the stylesheet
 * lines matter to a TypeScript render specifically is not established, which is
 * the other reason not to bank on it.
 *
 * What it would buy is the first render after a restart, on a site whose
 * Lighthouse profile is dominated by render-blocking CSS and an LCP element
 * that is a paragraph of text — measured with a warm server, where the document
 * took 60 ms and the score was unchanged. Trading 4 s of boot and a 4 s window
 * of slow responses after every restart for one faster render is not a trade
 * this site should make. `warmHighlighter` says what it does instead.
 */

/**
 * Warm the highlighter, so that the first code block rendered after a restart
 * is not the one that pays for the whole build. Called once from the boot
 * sequence.
 *
 * It is *not* awaited by its caller, and it does not need to be: it does the
 * cheap half of the work and finishes in a few hundred milliseconds. The
 * expensive half — the first tokenisation — is deliberately left to the first
 * request, for the reasons in the note above. Errors are caught and logged here
 * so that a rejection cannot escape as an unhandled rejection.
 */
export async function warmHighlighter(): Promise<void> {
  try {
    await getHighlighter()
    await getThemes()
  } catch (error) {
    console.error('[shiki] warm-up failed:', error)
  }
}

