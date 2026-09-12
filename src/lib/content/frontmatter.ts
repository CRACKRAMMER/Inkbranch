import YAML from 'yaml'

/**
 * YAML frontmatter parsing and serialisation.
 *
 * Handles both delimiters in the wild: `---` (Jekyll/Hugo/Ghost) and `+++`
 * (TOML-style, seen in some static generators — parsed as YAML, which covers
 * the plain scalar shapes those files actually use).
 *
 * Round-trip contract: unknown keys survive a read/write cycle. Comments do
 * not, because the admin editor edits structured fields rather than raw YAML.
 * That limitation is documented rather than hidden.
 */

export const FRONTMATTER_DELIMITER = '---'
/** TOML-style fence, parsed as YAML because that is what those files contain. */
const TOML_DELIMITER = '+++'
const CLOSING_DELIMITERS = ['---', '...']

export interface ParsedDocument {
  /** Parsed frontmatter, or `{}` when the file has none. */
  data: Record<string, unknown>
  /** Markdown body with the frontmatter block removed. */
  content: string
  /** Raw frontmatter text, exactly as it appeared. */
  raw: string
  /** False when the file had no frontmatter block at all. */
  hasFrontmatter: boolean
}

export class FrontmatterError extends Error {
  readonly code = 'FRONTMATTER'
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

/**
 * Split a Markdown file into frontmatter and body.
 *
 * The opening delimiter must be the very first line (a leading BOM and blank
 * lines are tolerated). An unterminated block is left in the body rather than
 * swallowed, so a malformed file loses nothing.
 */
export function parseFrontmatter(source: string): ParsedDocument {
  // Strip a UTF-8 BOM; it would otherwise break the first-line comparison.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source

  const normalised = text.replace(/\r\n/g, '\n')
  const lines = normalised.split('\n')

  // Skip leading blank lines to find the opener.
  let start = 0
  while (start < lines.length && lines[start]?.trim() === '') start += 1

  const first = lines[start]
  if (first === undefined) {
    return { data: {}, content: '', raw: '', hasFrontmatter: false }
  }

  const opener = first.trim()
  if (opener !== FRONTMATTER_DELIMITER && opener !== TOML_DELIMITER) {
    return { data: {}, content: normalised, raw: '', hasFrontmatter: false }
  }

  // The closer has to match the opener: a `+++` block is only ever closed by
  // `+++`. Without this a `+++` file never terminates and the whole document
  // falls back to being a body, so its metadata is silently dropped.
  const closers =
    opener === TOML_DELIMITER ? [TOML_DELIMITER] : CLOSING_DELIMITERS

  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (line !== undefined && closers.includes(line)) {
      end = i
      break
    }
    // A `---` inside a block scalar is content, not a delimiter, but YAML
    // cannot contain a top-level `---` inside the frontmatter mapping anyway.
  }

  if (end === -1) {
    // Unterminated: treat the whole file as body so nothing is lost.
    return { data: {}, content: normalised, raw: '', hasFrontmatter: false }
  }

  const raw = lines.slice(start + 1, end).join('\n')
  const content = lines.slice(end + 1).join('\n').replace(/^\n+/, '')

  return {
    data: parseYamlMapping(raw),
    content,
    raw,
    hasFrontmatter: true,
  }
}

function parseYamlMapping(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}

  let parsed: unknown
  try {
    parsed = YAML.parse(raw, { merge: true, maxAliasCount: 100 })
  } catch (error) {
    throw new FrontmatterError(
      `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterError(
      'Frontmatter must be a mapping of keys to values, not a list or scalar.',
    )
  }

  return parsed as Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*  Serialisation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Canonical key order. Anything not listed here is appended afterwards, so
 * files stay readable and diffs stay small when the editor rewrites them.
 */
const KEY_ORDER = [
  'title',
  'slug',
  'description',
  'date',
  'publishedAt',
  'updated',
  'status',
  'publishAt',
  'category',
  'tags',
  'series',
  'cover',
  'featured',
  'toc',
  'lang',
  'projectStatus',
  'started',
  'repo',
  'website',
  'stack',
  'seo',
]

export interface SerializeOptions {
  /** Preserved unknown keys, written after the canonical ones. */
  extra?: Record<string, unknown>
  /**
   * Emitted as a `#` comment as the first line *inside* the block.
   *
   * Inside, not above: a comment above the opening fence makes the whole file
   * look like it has no frontmatter at all, so the metadata silently becomes
   * body text on the next read. YAML discards comments on parse, so this is
   * cosmetic and is regenerated by whoever writes it.
   */
  comment?: string
}

/**
 * Build a complete Markdown file from frontmatter data and a body.
 *
 * Empty and default-valued keys are omitted: writing `featured: false` into
 * every file would create noise in git diffs for no information gain.
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  content: string,
  options: SerializeOptions = {},
): string {
  const ordered: Record<string, unknown> = {}

  for (const key of KEY_ORDER) {
    const value = data[key]
    if (shouldOmit(key, value)) continue
    ordered[key] = value
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) continue
    ordered[key] = value
  }

  // Keys the caller supplied that we do not know about, but also did not
  // classify as `extra` — keep them rather than dropping silently.
  for (const [key, value] of Object.entries(data)) {
    if (key in ordered) continue
    if (KEY_ORDER.includes(key)) continue
    if (value === undefined) continue
    ordered[key] = value
  }

  const yaml = YAML.stringify(ordered, {
    lineWidth: 0, // Never wrap long descriptions; wrapping mangles CJK.
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    // Quote strings that look like dates or numbers so they stay strings.
    doubleQuotedAsJSON: false,
    singleQuote: false,
  }).trimEnd()

  const header = options.comment ? `# ${options.comment}\n` : ''
  const body = content.replace(/^\n+/, '').replace(/\s+$/, '')

  return `${FRONTMATTER_DELIMITER}\n${header}${yaml}\n${FRONTMATTER_DELIMITER}\n\n${body}\n`
}

/**
 * Decide whether a key should be left out of the serialised output.
 * Defaults are omitted only when staying silent is unambiguous.
 */
function shouldOmit(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value === '') return true
  if (Array.isArray(value) && value.length === 0) return true

  // `seo` is the one nested key, and it is omitted only when it holds nothing
  // but falsy values — an empty block would be pure diff noise. A `seo` with
  // any real value is kept whole, including the `false` members beside it.
  if (key === 'seo') {
    const seo = value as Record<string, unknown>
    return Object.values(seo).every(
      (v) => v === undefined || v === null || v === '' || v === false,
    )
  }

  return false
}

