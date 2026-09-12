import { HeadingSlugger } from '@/lib/markdown/slugger'
import { slugFromFilename, slugify } from '@/lib/utils/slug'
import { stripMarkdown, summarize, textStats } from '@/lib/utils/text'
import type { ContentType } from './schema'

/**
 * Everything derived from a document's body rather than declared in its
 * frontmatter. Kept pure and synchronous so both the sync engine and the
 * importer can use it, and so it is trivially unit-testable.
 */

export interface Heading {
  id: string
  text: string
  level: number
}

export interface DerivedContent {
  title: string
  slug: string
  description: string
  headings: Heading[]
  wordCount: number
  readingTime: number
  /** Search text: the stripped body, truncated to a sane budget. */
  plainText: string
}

/** Cap the plain-text representation we keep in memory and send to search. */
const MAX_PLAIN_TEXT = 60_000

export interface DeriveInput {
  type: ContentType
  /** Filename without extension, used as the last-resort slug and title. */
  filename: string
  body: string
  title?: string | undefined
  slug?: string | undefined
  description?: string | undefined
}

export function deriveContent(input: DeriveInput): DerivedContent {
  const headings = extractHeadings(input.body)
  const title = pickTitle(input, headings)
  const slug = input.slug?.trim() || slugify(title) || slugFromFilename(input.filename)
  const plainText = stripMarkdown(input.body).slice(0, MAX_PLAIN_TEXT)
  const description = pickDescription(input, plainText, headings)
  const stats = textStats(plainText)

  return {
    title,
    slug,
    description,
    headings,
    wordCount: stats.words,
    readingTime: stats.readingTime,
    plainText,
  }
}

/* -------------------------------------------------------------------------- */
/*  Title                                                                      */
/* -------------------------------------------------------------------------- */

function pickTitle(input: DeriveInput, headings: Heading[]): string {
  const declared = input.title?.trim()
  if (declared) return declared

  // Notes may omit a title: borrow the first heading, then the first line,
  // then fall back to the filename.
  const firstHeading = headings.find((h) => h.level <= 3)
  if (firstHeading) return firstHeading.text

  const firstLine = firstNonEmptyLine(input.body)
  if (firstLine) {
    const cleaned = stripMarkdown(firstLine).trim()
    if (cleaned) return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned
  }

  return humanizeFilename(input.filename)
}

function firstNonEmptyLine(body: string): string | undefined {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // Skip constructs that are never a title.
    if (/^[#>|`~]/.test(line)) continue
    if (/^[=-]{3,}$/.test(line)) continue
    return line
  }
  return undefined
}

/** `2026-09-11-linux-notes` → `Linux Notes` */
export function humanizeFilename(filename: string): string {
  const stem = filename.replace(/\.(md|markdown|mdx)$/i, '')
  const withoutDate = stem.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_\s]+/, '')
  const words = withoutDate.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return 'Untitled'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/* -------------------------------------------------------------------------- */
/*  Description                                                                */
/* -------------------------------------------------------------------------- */

function pickDescription(
  input: DeriveInput,
  plainText: string,
  headings: Heading[],
): string {
  const declared = input.description?.trim()
  if (declared) return declared

  // Drop the leading heading from the excerpt source; repeating the title in
  // the description wastes the snippet.
  const withoutLeadingHeading = stripLeadingHeading(plainText, headings)
  return summarize(withoutLeadingHeading || plainText, 200)
}

function stripLeadingHeading(plainText: string, headings: Heading[]): string {
  const first = headings[0]
  if (!first) return plainText
  const trimmed = plainText.trimStart()
  if (!trimmed.startsWith(first.text)) return plainText
  return trimmed.slice(first.text.length).trimStart()
}

/* -------------------------------------------------------------------------- */
/*  Headings                                                                   */
/* -------------------------------------------------------------------------- */

interface FenceState {
  marker: string
  length: number
}

/**
 * Extract the heading tree from raw Markdown.
 *
 * Runs the same slugger as the renderer so the IDs match, and skips fenced code
 * blocks — a `# comment` inside a shell snippet is not a heading.
 */
export function extractHeadings(body: string): Heading[] {
  const slugger = new HeadingSlugger()
  const headings: Heading[] = []
  let fence: FenceState | null = null
  /** Previous line, kept so setext underlines can be attributed to it. */
  let pending: { text: string; isParagraph: boolean } | null = null

  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '`'
      const length = fenceMatch[1]?.length ?? 3
      if (!fence) {
        fence = { marker, length }
      } else if (marker === fence.marker && length >= fence.length) {
        fence = null
      }
      pending = null
      continue
    }

    if (fence) continue

    if (!line.trim()) {
      pending = null
      continue
    }

    // ATX headings: `## Title` or `## Title ##`
    const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (atx) {
      const level = atx[1]?.length ?? 1
      const text = cleanHeadingText(atx[2] ?? '')
      if (text) headings.push({ id: slugger.slug(text), text, level })
      pending = null
      continue
    }

    // Setext underline. `=` is always a setext h1. `-` is ambiguous with a
    // thematic break, so it only counts when it underlines a paragraph line —
    // which is exactly the rule the Markdown spec uses.
    const setext = /^\s{0,3}(=+|-+)\s*$/.exec(line)
    if (setext && pending?.isParagraph) {
      const marker = setext[1] ?? ''
      // Three or more dashes on their own would also be a thematic break, but
      // immediately after paragraph text CommonMark resolves it as setext.
      const level = marker.startsWith('=') ? 1 : 2
      const text = cleanHeadingText(pending.text)
      if (text) headings.push({ id: slugger.slug(text), text, level })
      pending = null
      continue
    }

    // Ordinary paragraph text — eligible to become a setext heading.
    pending = {
      text: line.trim(),
      isParagraph: !isBlockStart(line),
    }
  }

  return headings
}

/** Lines that open a block construct and therefore cannot be setext text. */
function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line) || // list item
    /^\s{0,3}>/.test(line) || // blockquote
    /^\s{0,3}\|/.test(line) || // table row
    /^\s{0,3}:::[a-z-]/.test(line) || // directive
    /^\s{0,3}</.test(line) // html block
  )
}

/** Strip inline Markdown from heading text so the anchor label reads cleanly. */
function cleanHeadingText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\\)\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

/** Minimum number of headings before a table of contents is worth showing. */
export const MIN_HEADINGS_FOR_TOC = 2

export function shouldShowToc(tocEnabled: boolean, headings: Heading[]): boolean {
  return tocEnabled && headings.length >= MIN_HEADINGS_FOR_TOC
}

export { slugify }
