/**
 * Text measurement helpers.
 *
 * Chinese and English need different units. Counting "words" by whitespace makes
 * a 3000-character Chinese essay look like a single word, so CJK ideographs are
 * counted per character and everything else per whitespace-delimited token.
 */

/**
 * The CJK ranges, as a character-class body.
 *
 * Exported as *text* rather than as a finished regex because three call sites
 * need it in three shapes: a global match, a boolean test, and spliced into a
 * longer negated class in `slug.ts`. Writing it out at each of them is how
 * `slug.ts` came to accept fewer scripts than everything around it did.
 *
 * - U+3400-U+4DBF  CJK Unified Ideographs Extension A
 * - U+4E00-U+9FFF  CJK Unified Ideographs
 * - U+F900-U+FAFF  CJK Compatibility Ideographs
 * - U+3040-U+30FF  Hiragana and Katakana
 * - U+AC00-U+D7AF  Hangul syllables
 *
 * Deliberately no Extension B and beyond: those live outside the BMP and would
 * need surrogate pairs in the class, which makes the offset arithmetic in
 * `tokenize` wrong for a script no part of this site is written in.
 */
export const CJK_RANGES =
  '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'

const CJK = new RegExp(`[${CJK_RANGES}]`, 'g')
const CJK_TEST = new RegExp(`[${CJK_RANGES}]`)
const LATIN_TOKEN = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g

export interface TextStats {
  /** CJK characters + Latin tokens. Used for display, not for time. */
  words: number
  cjkChars: number
  latinWords: number
  /** Whole minutes, minimum 1. */
  readingTime: number
}

/**
 * Reading speed constants. Both sit in the middle of the published ranges:
 * adults read Latin prose at 200–260 wpm, and Chinese at 300–500 cpm.
 */
const LATIN_WPM = 220
const CJK_CPM = 400

export function textStats(input: string): TextStats {
  const cjkMatches = input.match(CJK)
  const cjkChars = cjkMatches ? cjkMatches.length : 0

  // Strip CJK before counting Latin tokens so mixed text is not double counted.
  const latinSource = cjkChars ? input.replace(CJK, ' ') : input
  const latinMatches = latinSource.match(LATIN_TOKEN)
  const latinWords = latinMatches ? latinMatches.length : 0

  const minutes = latinWords / LATIN_WPM + cjkChars / CJK_CPM
  const readingTime = Math.max(1, Math.round(minutes))

  return { words: cjkChars + latinWords, cjkChars, latinWords, readingTime }
}

export function containsCJK(input: string): boolean {
  return CJK_TEST.test(input)
}

/**
 * Wide characters, as a class body.
 *
 * Wider than `CJK_RANGES`, because this one answers "how much room does this
 * take" rather than "is this Chinese": full-width punctuation (`，。：`) and the
 * fullwidth forms block sit outside the ideograph ranges but occupy the same
 * square of a line. The halfwidth forms (`U+FF61`-`U+FFDC`) are deliberately
 * absent — those are narrow by definition.
 */
const WIDE_RANGES = `${CJK_RANGES}\\u3000-\\u303f\\uff01-\\uff60\\uffe0-\\uffe6`
const WIDE = new RegExp(`[${WIDE_RANGES}]`)
const WIDE_GLOBAL = new RegExp(`[${WIDE_RANGES}]`, 'g')

/** Width of one character in half-width units: 2 for CJK, 1 otherwise. */
export function charWidth(char: string): number {
  return WIDE.test(char) ? 2 : 1
}

/**
 * Width of a string in half-width units.
 *
 * A budget counted in characters is wrong for mixed scripts: 160 Chinese
 * characters occupy about twice the room of 160 Latin ones, so one shared
 * character budget either clips English early or overruns the space Chinese
 * gets. Half-width units give both the same budget.
 *
 * Counted per code point, so an astral character is one character here even
 * though it is two UTF-16 units. Emoji measure as one unit rather than the two
 * they usually occupy in a font — an error in the safe direction for every
 * caller that uses this to decide what fits.
 */
export function displayWidth(input: string): number {
  const wide = input.match(WIDE_GLOBAL)
  return Array.from(input).length + (wide ? wide.length : 0)
}

/**
 * Remove Markdown syntax to produce plain text for excerpts and search.
 * Structure-aware enough to keep the words and drop the punctuation.
 */
export function stripMarkdown(md: string): string {
  return md
    // Fenced code blocks — content is not prose.
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/^~~~[\s\S]*?^~~~/gm, ' ')
    // Indented code blocks.
    .replace(/^(?: {4}|\t).*$/gm, ' ')
    // Inline code.
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    // Images -> alt text; links -> label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    // Footnote markers and reference definitions.
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/^\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    // Headings, blockquotes, list markers.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    // Tables: keep cell text, drop pipes and separator rows.
    .replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    // Directives and raw HTML.
    .replace(/:::[a-z-]*(?:\{[^}]*\})?/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Emphasis markers, but not underscores inside identifiers.
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    // Entities and leftover whitespace.
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build a one-line summary that respects sentence boundaries.
 * Falls back to a hard cut with an ellipsis when there is no terminator.
 */
export function summarize(input: string, maxLength = 200): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text

  const window = text.slice(0, maxLength + 1)
  // CJK terminators plus the Latin set.
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  )

  if (boundary >= maxLength * 0.5) {
    const end = window[boundary] === ' ' ? boundary : boundary + 1
    return text.slice(0, end).trim()
  }

  const lastSpace = window.lastIndexOf(' ')
  const cut = lastSpace > maxLength * 0.6 ? lastSpace : maxLength
  return `${text.slice(0, cut).trimEnd()}…`
}

/** Truncate without splitting a surrogate pair. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input
  const sliced = Array.from(input).slice(0, maxLength).join('')
  return `${sliced}…`
}

/** Normalise a tag name for matching: trim, casefold, collapse spaces. */
export function normalizeTagName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

/** Stable hash of a string, used for cache keys and visitor salts. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
