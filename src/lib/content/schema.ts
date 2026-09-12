import { z } from 'zod'

import {
  CONTENT_STATUSES,
  PROJECT_STATUSES,
  type ContentStatus,
  type ContentType,
} from './kinds'

/**
 * Frontmatter schemas.
 *
 * Single source of truth for what a valid document looks like. The parser, the
 * `content:validate` CLI, the import pipeline and the admin editor all validate
 * against these definitions, so a document that passes one passes all of them.
 *
 * The shapes differ per content type: a Note may omit almost everything, while
 * a Post must have a title and a date.
 *
 * The vocabulary the schemas are built from — which types exist, which statuses
 * each can take — is declared in `./kinds`, which imports nothing, and is
 * re-exported here so that server code has one place to reach for. Client code
 * should import from `./kinds` directly: see the note at the top of that file
 * for what it costs when it does not.
 */

export { CONTENT_STATUSES, CONTENT_TYPES, PROJECT_STATUSES } from './kinds'
export type { ContentStatus, ContentType, ProjectStatus } from './kinds'

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Dates arrive as `2026-09-11`, `2026-09-11 10:00`, an ISO timestamp, or a
 * value YAML already turned into a Date. Normalise all of them to a Date.
 *
 * A bare date is anchored to **UTC noon**, not midnight. The day an author
 * writes is a local fact with no timezone attached, and midnight UTC renders as
 * the previous day for every reader west of Greenwich. Noon moves the boundary
 * out to UTC-12 and UTC+11, which covers every inhabited offset but the two
 * easternmost — Kiritimati and a handful of Pacific islands see the next day.
 *
 * That residue is why the display layer formats dates in **UTC** rather than in
 * the reader's zone: with a UTC formatter the anchor is irrelevant, and the day
 * shown is the day written, everywhere. Noon is the belt to that pair of
 * braces.
 */
const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/

export const flexibleDate = z.preprocess((value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }
  if (typeof value === 'number') {
    const fromEpoch = new Date(value)
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch
  }
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const match = dateOnly.exec(trimmed)
  if (match) {
    return new Date(`${trimmed}T12:00:00.000Z`)
  }

  // `YYYY-MM-DD HH:mm(:ss)` is not valid ISO; make the separator explicit.
  const normalised = trimmed.includes(' ') && !trimmed.includes('T')
    ? trimmed.replace(' ', 'T')
    : trimmed

  const parsed = new Date(normalised)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}, z.date())

/** A tag is a short, non-empty label. */
export const tagSchema = z
  .string()
  .trim()
  .min(1, 'Tags cannot be empty')
  .max(80, 'Tags are limited to 80 characters')

/** Accepts `tags: [a, b]`, `tags: a, b` or a single string. */
export const tagListSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return [String(value)]
}, z.array(tagSchema).max(30, 'A document may have at most 30 tags'))

/** http(s) or site-relative URLs only. Blocks javascript: and data: payloads. */
export const safeUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine((value) => {
    if (value.startsWith('/')) return !value.startsWith('//')
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Must be an http(s) URL or a site-relative path starting with /')

export const seoSchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    description: z.string().trim().max(500).optional(),
    canonical: safeUrlSchema.optional(),
    ogImage: safeUrlSchema.optional(),
    noindex: z.coerce.boolean().default(false),
  })
  .default({ noindex: false })

/** Per-type status handling differs, so status is declared per schema below. */
export const baseFrontmatter = z.object({
  title: z.string().trim().max(300).optional(),
  slug: z.string().trim().max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  summary: z.string().trim().max(1000).optional(),
  date: flexibleDate.optional(),
  publishedAt: flexibleDate.optional(),
  updated: flexibleDate.optional(),
  category: z.string().trim().max(80).optional(),
  tags: tagListSchema,
  cover: safeUrlSchema.optional(),
  featured: z.coerce.boolean().default(false),
  toc: z.coerce.boolean().default(true),
  lang: z.string().trim().max(12).default('en'),
  series: z.string().trim().max(160).optional(),
  seo: seoSchema,
})

/* -------------------------------------------------------------------------- */
/*  Shared validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A scheduled document must carry the moment it goes live. Without this, a
 * `status: scheduled` file would sit unpublished forever with no explanation.
 */
function checkScheduled<T extends { status: ContentStatus; publishAt?: Date }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  if (value.status === 'scheduled' && !value.publishAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['publishAt'],
      message: 'status "scheduled" requires a publishAt timestamp',
    })
  }
}

/** Published documents need a timestamp for feeds, sorting and SEO. */
function checkPublished<T extends { status: ContentStatus; publishedAt?: Date }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  if (value.status === 'published' && !value.publishedAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['publishedAt'],
      message: 'status "published" requires a date',
    })
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-type schemas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Status is resolved from the date rather than defaulted, so it is optional
 * here and settled in each schema's `transform`.
 */
const optionalStatus = z.enum(CONTENT_STATUSES).optional()

/** `date` is the author-facing key; `publishedAt` is the canonical one. */
const publishedAtFrom = <T extends { date?: Date; publishedAt?: Date }>(v: T) =>
  v.publishedAt ?? v.date

/**
 * Decide a document's status.
 *
 * An explicit `status` always wins. Without one the date decides: a dated file
 * is published, an undated one is a draft.
 *
 * A plain `.default('published')` looks equivalent and is not. The most ordinary
 * file there is — a title and a body, no `date` — would come out published and
 * then trip `checkPublished` below, so a correct hand-written file would be
 * rejected outright. Falling back to `draft` holds it back instead, which the
 * author can see in the admin and fix by adding a date.
 */
function resolveStatus(
  status: ContentStatus | undefined,
  publishedAt: Date | undefined,
): ContentStatus {
  if (status) return status
  return publishedAt ? 'published' : 'draft'
}

/**
 * Canonicalise the date and settle the status in one step.
 *
 * Running as a `transform` rather than a `default` is what lets `status` see the
 * date; the `superRefine` handlers after it then check an explicit `status`
 * against the date it was given, which is where a genuine contradiction — a
 * file claiming `status: published` with no date at all — is reported.
 */
function withResolvedStatus<
  T extends { status?: ContentStatus; date?: Date; publishedAt?: Date },
>(v: T): T & { publishedAt: Date | undefined; status: ContentStatus } {
  const publishedAt = publishedAtFrom(v)
  return { ...v, publishedAt, status: resolveStatus(v.status, publishedAt) }
}

export const postFrontmatterSchema = baseFrontmatter
  .extend({
    title: z.string().trim().min(1, 'A post requires a title').max(300),
    status: optionalStatus,
    publishAt: flexibleDate.optional(),
  })
  .transform(withResolvedStatus)
  .superRefine((v, ctx) => {
    checkScheduled(v, ctx)
    checkPublished(v, ctx)
  })

export const noteFrontmatterSchema = baseFrontmatter
  .extend({
    // Notes may omit the title entirely; the loader derives one.
    title: z.string().trim().max(300).optional(),
    status: optionalStatus,
    publishAt: flexibleDate.optional(),
  })
  .transform(withResolvedStatus)
  .superRefine((v, ctx) => {
    checkScheduled(v, ctx)
  })

export const projectFrontmatterSchema = baseFrontmatter
  .extend({
    title: z.string().trim().min(1, 'A project requires a title').max(300),
    status: optionalStatus,
    publishAt: flexibleDate.optional(),
    projectStatus: z.enum(PROJECT_STATUSES).default('active'),
    started: flexibleDate.optional(),
    repo: safeUrlSchema.optional(),
    website: safeUrlSchema.optional(),
    stack: z.preprocess((value) => {
      if (value === undefined || value === null || value === '') return []
      if (Array.isArray(value)) {
        return value
          .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
          .filter(Boolean)
      }
      if (typeof value === 'string') {
        return value.split(',').map((v) => v.trim()).filter(Boolean)
      }
      return [String(value)]
    }, z.array(z.string().trim().max(60)).max(30)),
  })
  .transform(withResolvedStatus)
  .superRefine((v, ctx) => {
    checkScheduled(v, ctx)
    checkPublished(v, ctx)
  })

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

export function frontmatterSchemaFor(type: 'post'): typeof postFrontmatterSchema
export function frontmatterSchemaFor(type: 'note'): typeof noteFrontmatterSchema
export function frontmatterSchemaFor(
  type: 'project',
): typeof projectFrontmatterSchema
export function frontmatterSchemaFor(type: ContentType): z.ZodType
export function frontmatterSchemaFor(type: ContentType): z.ZodType {
  switch (type) {
    case 'post':
      return postFrontmatterSchema
    case 'note':
      return noteFrontmatterSchema
    case 'project':
      return projectFrontmatterSchema
  }
}

/**
 * Keys we handle ourselves. Anything else found in the frontmatter is kept in
 * `extra` and written back verbatim, so hand-authored metadata the app does not
 * understand is never silently deleted by an admin save.
 */
export const KNOWN_FRONTMATTER_KEYS = new Set([
  // shared
  'title', 'slug', 'description', 'summary', 'date', 'publishedAt', 'updated',
  'category', 'tags', 'cover', 'featured', 'toc', 'lang', 'series', 'seo',
  'status', 'draft', 'publishAt',
  // project
  'projectStatus', 'started', 'repo', 'website', 'stack',
  // seo sub-keys surfaced at the top level by older posts
  'canonical', 'ogImage', 'noindex', 'seoTitle', 'seoDescription',
  // importer bookkeeping — meaningless downstream, dropped on rewrite
  'importedFrom', 'originalPath',
])

export function splitFrontmatterKeys(
  raw: Record<string, unknown>,
): { known: Record<string, unknown>; extra: Record<string, unknown> } {
  const known: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) known[key] = value
    else extra[key] = value
  }
  return { known, extra }
}

/**
 * Map legacy or alternate key spellings onto the canonical ones.
 * Keeps the importer forgiving without loosening the schema.
 */
export function normaliseFrontmatterKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }

  const aliases: Record<string, string> = {
    summary: 'description',
    excerpt: 'description',
    tags_string: 'tags',
    pubDate: 'date',
    publish_date: 'date',
    created: 'date',
    modified: 'updated',
    image: 'cover',
    thumbnail: 'cover',
    category: 'category',
    categories: 'category',
    project_status: 'projectStatus',
    github: 'repo',
    homepage: 'website',
    tech: 'stack',
    techStack: 'stack',
    canonical: 'seo',
    seoTitle: 'seo',
    seoDescription: 'seo',
  }

  // `summary` and `excerpt` only become `description` when nothing better is
  // present. Both spellings are common in hand-written and imported files.
  if (out.description === undefined) {
    const alias = typeof out.summary === 'string' ? out.summary : out.excerpt
    if (typeof alias === 'string') out.description = alias
  }

  for (const [from, to] of Object.entries(aliases)) {
    if (from === 'summary' || from === 'excerpt') continue
    if (out[from] === undefined || out[to] !== undefined) continue

    if (from === 'categories') {
      out[to] = Array.isArray(out[from]) ? out[from][0] : out[from]
    } else if (from === 'canonical' || from === 'seoTitle' || from === 'seoDescription') {
      continue
    } else {
      out[to] = out[from]
    }
  }

  // `draft: true` is a common convention; map it onto status. Only the `true`
  // direction is mapped: `draft: false` must not force a publish onto a file
  // with no date, which would then fail validation instead of being read.
  if (out.draft !== undefined && out.status === undefined) {
    const isDraft = out.draft === true || out.draft === 'true' || out.draft === 1
    if (isDraft) out.status = 'draft'
  }

  // Lift legacy top-level SEO keys into the nested object.
  const seo = (out.seo && typeof out.seo === 'object' ? out.seo : {}) as Record<
    string,
    unknown
  >
  const liftedSeo: Record<string, unknown> = { ...seo }
  if (typeof out.canonical === 'string' && liftedSeo.canonical === undefined) {
    liftedSeo.canonical = out.canonical
  }
  if (typeof out.seoTitle === 'string' && liftedSeo.title === undefined) {
    liftedSeo.title = out.seoTitle
  }
  if (
    typeof out.seoDescription === 'string' &&
    liftedSeo.description === undefined
  ) {
    liftedSeo.description = out.seoDescription
  }
  if (out.noindex !== undefined && liftedSeo.noindex === undefined) {
    liftedSeo.noindex = out.noindex
  }
  if (Object.keys(liftedSeo).length > 0) out.seo = liftedSeo

  return out
}
