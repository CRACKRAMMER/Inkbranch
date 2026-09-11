/**
 * Slug generation.
 *
 * Handles Latin and CJK input. CJK has no word boundaries, so instead of
 * transliterating (which needs a large mapping table) we keep the characters
 * and let the URL carry them percent-encoded. That is stable, reversible by
 * eye, and matches how Chinese-language sites behave in practice.
 */

import { CJK_RANGES } from './text'

/** Characters that are safe to appear literally in a slug. */
const SLUG_SAFE = new RegExp(`[^a-z0-9${CJK_RANGES}]+`, 'g')
const LEADING_TRAILING_SEPARATORS = /^-+|-+$/g
/** The same class, anchored: what `isValidSlug` accepts in full. */
const SLUG_PATTERN = new RegExp(`^[a-z0-9${CJK_RANGES}-]+$`)
/** Tags are a single URL segment, so anything else becomes a separator. */
const TAG_UNSAFE = new RegExp(`[^a-z0-9${CJK_RANGES}]+`, 'g')

const MAX_SLUG_LENGTH = 120
/** UTF-8 length guard: Postgres varchar(200), and Chinese chars cost 3 bytes. */
const MAX_SLUG_BYTES = 180

export function slugify(input: string, fallback = 'untitled'): string {
  const base = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(SLUG_SAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(LEADING_TRAILING_SEPARATORS, '')

  if (!base) return fallback
  return truncateSlug(base)
}

/**
 * Trim a slug to its length budget without cutting a multi-byte character in
 * half or leaving a dangling separator.
 */
function truncateSlug(slug: string): string {
  let out = slug
  if (out.length > MAX_SLUG_LENGTH) out = out.slice(0, MAX_SLUG_LENGTH)
  while (Buffer.byteLength(out, 'utf8') > MAX_SLUG_BYTES && out.length > 1) {
    out = out.slice(0, -1)
  }
  return out.replace(LEADING_TRAILING_SEPARATORS, '') || 'untitled'
}

/**
 * Turn a filename into a slug, dropping a leading date prefix such as
 * `2026-09-11-linux-networking` → `linux-networking`.
 */
export function slugFromFilename(filename: string): string {
  const stem = filename.replace(/\.(md|markdown|mdx)$/i, '')
  const withoutDate = stem.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_\s]+/, '')
  return slugify(withoutDate, slugify(stem))
}

/** True when the value is already a valid slug (used by the validator). */
export function isValidSlug(value: string): boolean {
  if (!value || value.length > MAX_SLUG_LENGTH) return false
  if (Buffer.byteLength(value, 'utf8') > MAX_SLUG_BYTES) return false
  if (value.startsWith('-') || value.endsWith('-')) return false
  if (value.includes('--')) return false
  return SLUG_PATTERN.test(value)
}

/**
 * Tag slugs. ASCII plus ideographs, so `/tag/linux` stays readable and
 * `/tag/数据库` still works — Chinese has no ASCII spelling to fall back on.
 */
export function tagSlug(name: string): string {
  const base = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(TAG_UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(LEADING_TRAILING_SEPARATORS, '')
  return base.slice(0, 100) || 'tag'
}

/**
 * Append `-2`, `-3`, … until the slug is unused.
 * Bounded so a pathological input cannot spin forever.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}
