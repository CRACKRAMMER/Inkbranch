import { z } from 'zod'

import {
  CONTENT_STATUSES,
  PROJECT_STATUSES,
  type ContentStatus,
  type ContentType,
  type ProjectStatus,
} from '@/lib/content/schema'

/**
 * The bridge between the metadata panel and the YAML on disk.
 *
 * Two rules shape everything here:
 *
 *  1. **The form owns a fixed set of keys.** Everything else in the file — keys
 *     the schema knows but the panel does not expose (`lang`), and keys nothing
 *     knows at all — is passed through untouched via the `extra` bucket the
 *     writer already maintains. An admin save must never delete metadata it did
 *     not understand.
 *  2. **Nothing is written that the author did not set.** Empty optional fields
 *     remove their key rather than writing `''`, and a key that was absent stays
 *     absent: a save should not litter a hand-written file with defaults.
 *
 * Pure and isomorphic, so the panel validates at the same moment the server
 * does, against the same schema.
 */

/**
 * Keys the panel is responsible for. The list includes aliases the normaliser
 * understands (`summary`, `pubDate`, `github`, …) because the panel now holds
 * the canonical value for each of them — leaving an alias behind would give the
 * file two contradictory spellings of the same field.
 */
const FORM_OWNED_KEYS = new Set([
  'title',
  'slug',
  'description',
  'status',
  'date',
  'publishedAt',
  'publishAt',
  'updated',
  'tags',
  'category',
  'series',
  'cover',
  'featured',
  'toc',
  'seo',
  'projectStatus',
  'started',
  'repo',
  'website',
  'stack',
  // aliases superseded by a canonical key above
  'summary',
  'excerpt',
  'draft',
  'pubDate',
  'publish_date',
  'created',
  'modified',
  'image',
  'thumbnail',
  'categories',
  'project_status',
  'github',
  'homepage',
  'tech',
  'techStack',
  'tags_string',
  // legacy top-level SEO, folded into `seo`
  'canonical',
  'seoTitle',
  'seoDescription',
  'noindex',
])

const commaList = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return []
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry).trim()).filter(Boolean)
    }
    return String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  },
  z.array(z.string().trim().min(1).max(160)).max(30),
)

/** `YYYY-MM-DD`, or empty for "no date". */
const dateField = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'Use YYYY-MM-DD',
  })

/**
 * Accepts either a `datetime-local` string from the browser or a full ISO
 * instant; both are stored as an ISO instant so the file never carries a
 * timestamp whose timezone is unstated.
 */
const instantField = z
  .string()
  .trim()
  .refine(
    (value) => {
      if (value === '') return true
      if (Number.isNaN(Date.parse(value))) return false
      return /^\d{4}-\d{2}-\d{2}T/.test(value)
    },
    { message: 'Use a full date and time' },
  )

const urlField = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) => {
      if (value === '') return true
      if (value.startsWith('/')) return !value.startsWith('//')
      try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Must be an http(s) URL or a path starting with /' },
  )

export const contentFormSchema = z.object({
  title: z.string().trim().max(300),
  slug: z
    .string()
    .trim()
    .max(200)
    .refine((value) => value === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), {
      message: 'Lowercase letters, digits and single hyphens only',
    }),
  description: z.string().trim().max(1000),
  status: z.enum(CONTENT_STATUSES),
  date: dateField,
  publishAt: instantField,
  tags: commaList,
  category: z.string().trim().max(80),
  series: z.string().trim().max(160),
  cover: urlField,
  featured: z.boolean(),
  toc: z.boolean(),
  seoTitle: z.string().trim().max(300),
  seoDescription: z.string().trim().max(500),
  seoCanonical: urlField,
  seoOgImage: urlField,
  seoNoindex: z.boolean(),
  projectStatus: z.enum(PROJECT_STATUSES),
  started: dateField,
  repo: urlField,
  website: urlField,
  stack: commaList,
})

export type ContentFormValues = z.infer<typeof contentFormSchema>

export const CONTENT_FORM_FIELD_NAMES = [
  'title',
  'slug',
  'description',
  'status',
  'date',
  'publishAt',
  'tags',
  'category',
  'series',
  'cover',
  'seoTitle',
  'seoDescription',
  'seoCanonical',
  'seoOgImage',
  'projectStatus',
  'started',
  'repo',
  'website',
  'stack',
] as const

export function emptyFormValues(type: ContentType): ContentFormValues {
  return {
    title: '',
    slug: '',
    description: '',
    status: 'draft',
    date: '',
    publishAt: '',
    tags: [],
    category: '',
    series: '',
    cover: '',
    featured: false,
    toc: true,
    seoTitle: '',
    seoDescription: '',
    seoCanonical: '',
    seoOgImage: '',
    seoNoindex: false,
    projectStatus: type === 'project' ? 'active' : 'active',
    started: '',
    repo: '',
    website: '',
    stack: [],
  }
}

/*
 * Reading
 */

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringOf).map((v) => v.trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * `YYYY-MM-DD` in UTC.
 *
 * The schema anchors a bare date at noon UTC precisely so that no timezone can
 * shift it across a day boundary; formatting back in UTC is the inverse of that
 * and keeps a date-only field stable through repeated saves.
 */
export function toDateInput(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
  }
  return ''
}

/** A full ISO instant, or empty. */
export function toInstantInput(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
  }
  return ''
}

/** Which key the file uses for its publication date. */
export function dateKeyOf(raw: Record<string, unknown>): 'date' | 'publishedAt' {
  if (raw.publishedAt !== undefined && raw.date === undefined) return 'publishedAt'
  return 'date'
}

/**
 * Build panel values from a document's *normalised* frontmatter.
 *
 * Normalised, not raw: the panel shows one canonical field per concept, so a
 * file written as `pubDate: 2026-01-02` opens with the same date as one written
 * as `date: 2026-01-02`, and saving rewrites it in the canonical spelling.
 */
export function formValuesFromFrontmatter(
  normalised: Record<string, unknown>,
  fallback: { status: ContentStatus },
): ContentFormValues {
  const seo = (normalised.seo && typeof normalised.seo === 'object' ? normalised.seo : {}) as Record<
    string,
    unknown
  >

  const rawStatus = stringOf(normalised.status)
  const status = (CONTENT_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as ContentStatus)
    : fallback.status

  const rawProjectStatus = stringOf(normalised.projectStatus)
  const projectStatus = (PROJECT_STATUSES as readonly string[]).includes(rawProjectStatus)
    ? (rawProjectStatus as ProjectStatus)
    : 'active'

  return {
    title: stringOf(normalised.title),
    slug: stringOf(normalised.slug),
    description: stringOf(normalised.description),
    status,
    date: toDateInput(normalised.date ?? normalised.publishedAt),
    publishAt: toInstantInput(normalised.publishAt),
    tags: listOf(normalised.tags),
    category: stringOf(normalised.category),
    series: stringOf(normalised.series),
    cover: stringOf(normalised.cover),
    featured: normalised.featured === true || normalised.featured === 'true',
    toc: normalised.toc === undefined ? true : normalised.toc !== false && normalised.toc !== 'false',
    seoTitle: stringOf(seo.title ?? normalised.seoTitle),
    seoDescription: stringOf(seo.description ?? normalised.seoDescription),
    seoCanonical: stringOf(seo.canonical ?? normalised.canonical),
    seoOgImage: stringOf(seo.ogImage),
    seoNoindex: seo.noindex === true || seo.noindex === 'true' || normalised.noindex === true,
    projectStatus,
    started: toDateInput(normalised.started),
    repo: stringOf(normalised.repo),
    website: stringOf(normalised.website),
    stack: listOf(normalised.stack),
  }
}

/*
 * Writing
 */

function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Fold panel values into a frontmatter object for the writer.
 *
 * `known` is the file's existing frontmatter with the panel-owned keys removed;
 * it is spread first so that keys the panel does not expose survive the save.
 * `dateKey` is the spelling the file already used for its publication date, so
 * an existing `publishedAt:` is not silently rewritten as `date:`.
 */
export function frontmatterFromForm(
  values: ContentFormValues,
  known: Record<string, unknown>,
  options: { dateKey: 'date' | 'publishedAt'; type: ContentType },
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...known }

  data.title = blankToUndefined(values.title)
  data.slug = blankToUndefined(values.slug)
  data.description = blankToUndefined(values.description)
  data.status = values.status

  delete data.date
  delete data.publishedAt
  const date = blankToUndefined(values.date)
  if (date) data[options.dateKey] = date

  const publishAt = blankToUndefined(values.publishAt)
  if (publishAt) {
    data.publishAt = publishAt
  } else {
    delete data.publishAt
  }

  data.tags = values.tags
  data.category = blankToUndefined(values.category)
  data.series = blankToUndefined(values.series)
  data.cover = blankToUndefined(values.cover)

  // `false` and `true` are the schema defaults; writing them adds a line to
  // every hand-authored file that says nothing the schema does not already say.
  if (values.featured) data.featured = true
  else delete data.featured
  if (!values.toc) data.toc = false
  else delete data.toc

  const seo: Record<string, unknown> = {}
  const seoTitle = blankToUndefined(values.seoTitle)
  const seoDescription = blankToUndefined(values.seoDescription)
  const seoCanonical = blankToUndefined(values.seoCanonical)
  const seoOgImage = blankToUndefined(values.seoOgImage)
  if (seoTitle) seo.title = seoTitle
  if (seoDescription) seo.description = seoDescription
  if (seoCanonical) seo.canonical = seoCanonical
  if (seoOgImage) seo.ogImage = seoOgImage
  if (values.seoNoindex) seo.noindex = true
  if (Object.keys(seo).length > 0) data.seo = seo
  else delete data.seo

  if (options.type === 'project') {
    data.projectStatus = values.projectStatus
    data.started = blankToUndefined(values.started)
    data.repo = blankToUndefined(values.repo)
    data.website = blankToUndefined(values.website)
    if (values.stack.length > 0) data.stack = values.stack
    else delete data.stack
  }

  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key]
  }

  return data
}

/** Strip everything the panel owns, leaving the keys that must be preserved. */
export function preservedKeys(normalised: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(normalised)) {
    if (!FORM_OWNED_KEYS.has(key)) kept[key] = value
  }
  return kept
}

/**
 * Validate a frontmatter object against the per-type schema.
 *
 * `extra` is stripped first: those keys are neither validated nor written by the
 * schema, and a strict parse would reject a file for metadata the admin is
 * deliberately preserving untouched.
 */
export function validateFrontmatter(
  type: ContentType,
  data: Record<string, unknown>,
  schema: z.ZodType,
): { ok: true } | { ok: false; fieldErrors: Record<string, string>; issues: string[] } {
  const result = schema.safeParse(data)
  if (result.success) return { ok: true }

  const fieldErrors: Record<string, string> = {}
  const issues: string[] = []
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.')
    const field = schemaFieldForPath(path)
    if (field && !fieldErrors[field]) fieldErrors[field] = issue.message
    issues.push(path ? `${path}: ${issue.message}` : issue.message)
  }
  return { ok: false, fieldErrors, issues }
}

/**
 * Point a schema issue at the panel input that produced it. `publishedAt` is
 * checked as a whole document because the panel writes the value under
 * `date`/`publishedAt` depending on the file, so either path maps to `date`.
 */
function schemaFieldForPath(path: string): string | null {
  if (!path) return null
  if (path === 'publishedAt' || path === 'date') return 'date'
  if (path.startsWith('seo.')) {
    const sub = path.slice(4)
    return sub === 'title'
      ? 'seoTitle'
      : sub === 'description'
        ? 'seoDescription'
        : sub === 'canonical'
          ? 'seoCanonical'
          : sub === 'ogImage'
            ? 'seoOgImage'
            : sub === 'noindex'
              ? 'seoNoindex'
              : null
  }
  return path.split('.')[0] ?? null
}
