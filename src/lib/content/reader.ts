import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@/env'
import { assertNoSymlinkPath, toPosix } from '@/lib/security/paths'
import { deriveContent, type Heading } from './derive'
import { parseFrontmatter, type ParsedDocument } from './frontmatter'
import { normalizeTagName } from '@/lib/utils/text'
import {
  CONTENT_ROOT,
  CONTENT_TYPE_DIRS,
  documentPath,
  isMarkdownFile,
  isReservedDir,
  parseRelativePath,
} from './paths'
import {
  normaliseFrontmatterKeys,
  splitFrontmatterKeys,
  type ContentStatus,
  type ContentType,
  type ProjectStatus,
} from './schema'
import { frontmatterSchemaFor } from './schema'
import { FrontmatterError } from './frontmatter'

/**
 * Reading documents from disk.
 *
 * A single process-wide cache keyed on (mtime, size) keeps repeated reads
 * cheap. Nothing here writes, so it is safe to call from any render path.
 */

export interface ContentDocument {
  type: ContentType
  /** POSIX path relative to CONTENT_ROOT, e.g. `posts/foo.md`. */
  relativePath: string
  absolutePath: string
  filename: string

  slug: string
  title: string
  description: string
  status: ContentStatus
  category: string | null
  tags: string[]
  series: string | null
  lang: string

  publishedAt: Date | null
  scheduledAt: Date | null
  updatedAt: Date
  /** Filesystem mtime, distinct from the frontmatter `updated` value. */
  fileMtime: Date

  cover: string | null
  featured: boolean
  toc: boolean

  seo: {
    title: string | null
    description: string | null
    canonical: string | null
    ogImage: string | null
    noindex: boolean
  }

  headings: Heading[]
  wordCount: number
  readingTime: number

  // Project-only fields.
  projectStatus: ProjectStatus | null
  startedAt: Date | null
  repoUrl: string | null
  websiteUrl: string | null
  techStack: string[]

  /** Unknown frontmatter keys, preserved so saves never destroy them. */
  extra: Record<string, unknown>

  /** Markdown body with the frontmatter block removed. */
  body: string
  /** Complete file contents. */
  raw: string
  /** Plain text derived from the body; used for search and previews. */
  plainText: string

  checksum: string
  byteSize: number
}

export class ContentReadError extends Error {
  readonly code = 'CONTENT_READ'
  override readonly cause?: unknown
  readonly relativePath: string

  constructor(message: string, relativePath: string, cause?: unknown) {
    super(message)
    this.name = 'ContentReadError'
    this.relativePath = relativePath
    this.cause = cause
  }
}

export interface ContentFileStat {
  relativePath: string
  absolutePath: string
  type: ContentType
  filename: string
  size: number
  mtime: Date
}

/* -------------------------------------------------------------------------- */
/*  Cache                                                                      */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  mtimeMs: number
  size: number
  document: ContentDocument
}

const cache = new Map<string, CacheEntry>()

/** Bound the cache so a huge content tree cannot exhaust memory. */
const MAX_CACHE_ENTRIES = 2000

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest insert.
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, entry)
}

/** Drop one document, or the entire cache when called with no argument. */
export function invalidateContentCache(relativePath?: string): void {
  if (relativePath === undefined) {
    cache.clear()
    return
  }
  cache.delete(toPosix(relativePath))
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read and parse a document. Returns null when the file does not exist, so
 * callers can distinguish "gone" from "broken".
 */
export async function readDocument(
  relativePath: string,
  options: { fresh?: boolean } = {},
): Promise<ContentDocument | null> {
  const key = toPosix(relativePath)
  const absolutePath = documentPath(key)
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(absolutePath)
  } catch (error) {
    if (isNotFound(error)) return null
    throw new ContentReadError(`Cannot stat ${key}`, key, error)
  }

  if (!stat.isFile()) return null

  const cached = cache.get(key)
  if (!options.fresh && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.document
  }

  const raw = await fs.readFile(absolutePath, 'utf8')
  const document = parseDocument({ relativePath: key, absolutePath, raw, stat })

  cacheSet(key, { mtimeMs: stat.mtimeMs, size: stat.size, document })
  return document
}

/** Stat one known document without scanning the tree or applying its scan cap. */
export async function statContentFile(relativePath: string): Promise<ContentFileStat | null> {
  const key = toPosix(relativePath)
  const located = parseRelativePath(key)
  if (!located) throw new ContentReadError(`Not a recognised content path: ${key}`, key)
  const absolutePath = documentPath(key)
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')
  const stat = await fs.stat(absolutePath).catch((error: unknown) => {
    if (isNotFound(error)) return null
    throw error
  })
  if (!stat?.isFile()) return null
  return {
    relativePath: key,
    absolutePath,
    type: located.type,
    filename: located.filename,
    size: stat.size,
    mtime: stat.mtime,
  }
}

interface ParseInput {
  relativePath: string
  absolutePath: string
  raw: string
  stat: { mtime: Date; size: number }
}

export function parseDocument(input: ParseInput): ContentDocument {
  const { relativePath, absolutePath, raw, stat } = input

  const located = parseRelativePath(relativePath)
  if (!located) {
    throw new ContentReadError(
      `Not a recognised content path: ${relativePath}`,
      relativePath,
    )
  }
  const { type, filename } = located

  let parsed: ParsedDocument
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    throw new ContentReadError(
      error instanceof FrontmatterError
        ? error.message
        : `Cannot parse ${relativePath}`,
      relativePath,
      error,
    )
  }

  const normalised = normaliseFrontmatterKeys(parsed.data)
  const { known, extra } = splitFrontmatterKeys(normalised)

  const result = frontmatterSchemaFor(type).safeParse(known)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new ContentReadError(
      `Invalid frontmatter in ${relativePath}: ${issues}`,
      relativePath,
      result.error,
    )
  }

  const data = result.data as Record<string, unknown>
  const derived = deriveContent({
    type,
    filename,
    body: parsed.content,
    title: asString(data.title),
    slug: asString(data.slug),
    description: asString(data.description),
  })

  const seo = (data.seo ?? {}) as Record<string, unknown>
  const updatedAt =
    asDate(data.updated) ?? stat.mtime
  const publishedAt = asDate(data.publishedAt) ?? asDate(data.date)

  return {
    type,
    relativePath,
    absolutePath,
    filename,

    slug: derived.slug,
    title: derived.title,
    description: derived.description,
    // The schema always resolves a status, so there is nothing to fall back to.
    status: data.status as ContentStatus,
    category: asString(data.category) ?? null,
    tags: dedupeTags(asStringArray(data.tags)),
    series: asString(data.series) ?? null,
    lang: asString(data.lang) ?? 'en',

    publishedAt: publishedAt ?? null,
    scheduledAt: asDate(data.publishAt) ?? null,
    updatedAt,
    fileMtime: stat.mtime,

    cover: asString(data.cover) ?? null,
    featured: Boolean(data.featured),
    toc: data.toc === undefined ? true : Boolean(data.toc),

    seo: {
      title: asString(seo.title) ?? null,
      description: asString(seo.description) ?? null,
      canonical: asString(seo.canonical) ?? null,
      ogImage: asString(seo.ogImage) ?? null,
      noindex: Boolean(seo.noindex),
    },

    headings: derived.headings,
    wordCount: derived.wordCount,
    readingTime: derived.readingTime,

    projectStatus: (data.projectStatus as ProjectStatus) ?? null,
    startedAt: asDate(data.started) ?? null,
    repoUrl: asString(data.repo) ?? null,
    websiteUrl: asString(data.website) ?? null,
    techStack: asStringArray(data.stack),

    extra,

    body: parsed.content,
    raw,
    plainText: derived.plainText,

    checksum: checksumOf(raw),
    byteSize: stat.size,
  }
}

/* -------------------------------------------------------------------------- */
/*  Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Walk the content tree and return every Markdown document.
 *
 * Bounded by `CONTENT_MAX_FILES`. Without that, a mis-mounted volume would turn
 * a boot check into a walk of the whole filesystem — and this runs on startup.
 */
export async function scanContentFiles(
  options: { maxFiles?: number } = {},
): Promise<ContentFileStat[]> {
  const limit = options.maxFiles ?? env.CONTENT_MAX_FILES
  const results: ContentFileStat[] = []

  const typeDirs = Object.entries(CONTENT_TYPE_DIRS) as [ContentType, string][]

  for (const [type, dir] of typeDirs) {
    const dirPath = path.join(CONTENT_ROOT, dir)
    await assertNoSymlinkPath(CONTENT_ROOT, dirPath, 'content directory')

    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if (isNotFound(error)) continue // An empty content tree is valid.
      throw error
    }

    for (const entry of entries) {
      if (results.length >= limit) return results
      if (isReservedDir(entry.name)) continue

      // Documents are flat within a type directory. Nested folders are ignored
      // rather than silently imported with a mangled slug.
      if (!entry.isFile()) continue
      if (!isMarkdownFile(entry.name)) continue

      const absolutePath = path.join(dirPath, entry.name)
      await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(absolutePath)
      } catch (error) {
        if (isNotFound(error)) continue // A file deleted mid-scan.
        throw error
      }
      if (!stat.isFile()) continue

      results.push({
        relativePath: toPosix(path.join(dir, entry.name)),
        absolutePath,
        type,
        filename: entry.name,
        size: stat.size,
        mtime: stat.mtime,
      })
    }
  }

  return results
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function checksumOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }
  return undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}

/** Tags are case-insensitively deduplicated; the first spelling wins. */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const normalised = normalizeTagName(tag)
    const key = normalised.toLowerCase()
    if (!normalised || seen.has(key)) continue
    seen.add(key)
    out.push(normalised)
  }
  return out
}
