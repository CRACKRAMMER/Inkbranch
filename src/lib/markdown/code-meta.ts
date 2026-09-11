/**
 * Fence meta parsing.
 *
 * Turns the string after a fence label into structured options:
 *
 *   ```ts title="src/index.ts" {3,7-9} /retry/ showLineNumbers start=5
 *   ```diff
 *   ```bash terminal
 *
 * The third spelling is the one that is not a language. A session typed at a
 * shell prompt is written as `bash` because that is what it is, and the word
 * `terminal` after it says it is a session rather than a script — which is a
 * distinction only the author knows, and the two look identical in a fence.
 *
 * Kept separate from the rehype plugin so it can be unit-tested without
 * building a syntax tree.
 */

export interface CodeFenceMeta {
  /** Label shown in the block header, e.g. `src/index.ts`. */
  title: string | null
  /** Secondary label on the right, e.g. `bash`. */
  badge: string | null
  showLineNumbers: boolean
  /** 1-based line numbers to emphasise. */
  highlightLines: number[]
  /** Substrings to emphasise within their line. */
  highlightWords: string[]
  /** First line number when numbering starts somewhere other than 1. */
  startLine: number
  /** A unified diff; `+`/`-` lines get diff styling. */
  isDiff: boolean
  /** A shell session; suppresses the language badge and styles the prompt. */
  isTerminal: boolean
  /** A diagram rendered client-side; the block is not syntax-highlighted. */
  isMermaid: boolean
}

const DEFAULTS: CodeFenceMeta = {
  title: null,
  badge: null,
  showLineNumbers: false,
  highlightLines: [],
  highlightWords: [],
  startLine: 1,
  isDiff: false,
  isTerminal: false,
  isMermaid: false,
}

/**
 * Language labels that mean "a session", rather than "a language".
 *
 * `bash` is deliberately not among them: a fence labelled `bash` is a shell
 * script far more often than it is a transcript, and it keeps its badge until
 * the author says otherwise with the `terminal` word below.
 */
const TERMINAL_LANGUAGES = new Set(['terminal', 'console', 'shellsession'])

/**
 * A bare `terminal` token in the meta string.
 *
 * The leading boundary is what keeps a quoted value out of it: in
 * `title="terminal"` the word is preceded by a quote, not by whitespace, so a
 * file called `terminal` does not become a session.
 */
const TERMINAL_PATTERN = /(?:^|\s)terminal(?:\s|$)/

/** `title="..."`, `title='...'`, or `title=foo` (terminated by whitespace). */
const TITLE_PATTERN = /(?:title|filename|file)=("([^"]*)"|'([^']*)'|(\S+))/
const BADGE_PATTERN = /(?:badge|label)=("([^"]*)"|'([^']*)'|(\S+))/
/** `{1,3-5,9}` */
const LINE_SPEC_PATTERN = /\{([\d,\s-]+)\}/
/**
 * `/word/` or `/two words/`, as a whole whitespace-delimited token.
 *
 * The boundaries matter: without them the slashes of a `title="src/index.ts"`
 * pair up with the ones around a word spec and swallow everything between.
 */
const WORD_SPEC_PATTERN = /(?:^|\s)\/([^/\n]+)\/(?=\s|$)/g
const START_PATTERN = /start=(\d+)/

export function parseCodeFenceMeta(
  meta: string | undefined,
  language: string | undefined,
): CodeFenceMeta {
  // The arrays are copied, not shared: `DEFAULTS` is module-level state, and a
  // spread alone would leave every call pushing into the same `highlightWords`,
  // leaking one fence's words into every fence parsed after it.
  const result: CodeFenceMeta = {
    ...DEFAULTS,
    highlightLines: [...DEFAULTS.highlightLines],
    highlightWords: [...DEFAULTS.highlightWords],
  }
  const lang = (language ?? '').toLowerCase()

  result.isDiff = lang === 'diff' || lang === 'patch'
  result.isTerminal = TERMINAL_LANGUAGES.has(lang)
  result.isMermaid = lang === 'mermaid'

  const badge = BADGE_PATTERN.exec(meta ?? '')
  result.badge = badge?.[2] ?? badge?.[3] ?? badge?.[4] ?? null

  // Diffs read better with numbers on both sides of the change. This depends on
  // the language alone, so it has to run before the early return below — a bare
  // ```diff fence carries no meta string at all.
  if (result.isDiff) result.showLineNumbers = true

  if (!meta) return result

  const title = TITLE_PATTERN.exec(meta)
  result.title = title?.[2] ?? title?.[3] ?? title?.[4] ?? null

  // A session is a session whatever it is written in, so this opts in on top of
  // the language rather than instead of it.
  if (TERMINAL_PATTERN.test(meta)) result.isTerminal = true

  const start = START_PATTERN.exec(meta)
  if (start?.[1]) {
    const parsed = Number.parseInt(start[1], 10)
    if (Number.isFinite(parsed) && parsed > 0) result.startLine = parsed
  }

  const lineSpec = LINE_SPEC_PATTERN.exec(meta)
  if (lineSpec?.[1]) {
    result.highlightLines = expandLineSpec(lineSpec[1], result.startLine)
  }

  for (const match of meta.matchAll(WORD_SPEC_PATTERN)) {
    const word = match[1]?.trim()
    // Guard against a stray pair of slashes in prose.
    if (word && word.length <= 80) result.highlightWords.push(word)
  }

  // `showLineNumbers` opts in; `showLineNumbers=false` opts back out.
  if (/(?:^|\s)showLineNumbers(?:=false)?(?:\s|$)/.test(meta)) {
    result.showLineNumbers = !/showLineNumbers=false/.test(meta)
  }
  if (/(?:^|\s)lineNumbers(?:\s|$)/.test(meta)) result.showLineNumbers = true

  return result
}

/**
 * Expand `1,3-5,9` into `[1,3,4,5,9]`.
 *
 * `startLine` shifts plain numbers so that `start=50 {1,2}` highlights the
 * first two *displayed* lines. Ranges are read as absolute line numbers when
 * they exceed the start offset, which is what authors expect from
 * `start=50 {55-57}`.
 */
export function expandLineSpec(spec: string, startLine = 1): number[] {
  const lines = new Set<number>()

  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed)
    if (range?.[1] && range[2]) {
      const from = Number.parseInt(range[1], 10)
      const to = Number.parseInt(range[2], 10)
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      const low = Math.min(from, to)
      const high = Math.max(from, to)
      // Bound the work: a `{1-100000}` typo should not build a huge array.
      if (high - low > 2000) continue
      for (let n = low; n <= high; n += 1) lines.add(n)
      continue
    }

    const single = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(single)) continue
    lines.add(single < startLine ? startLine + single - 1 : single)
  }

  return [...lines].sort((a, b) => a - b)
}
