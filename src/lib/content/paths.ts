import path from 'node:path'
import { env } from '@/env'
import { PathSecurityError, assertInside, toPosix } from '@/lib/security/paths'
import type { ContentType } from './schema'

/**
 * Path resolution for the content tree.
 *
 * Every filesystem path in the content engine is produced here, so the
 * containment guarantee lives in exactly one place. Callers never build a path
 * with `path.join` on their own.
 */

/** Root of the Markdown tree, resolved once. */
export const CONTENT_ROOT = path.resolve(process.cwd(), env.CONTENT_DIR)

/** Where in-flight writes live until they are atomically renamed into place. */
export const TMP_DIR = path.join(CONTENT_ROOT, '.tmp')

/** Advisory lock files, one per document being written. */
export const LOCK_DIR = path.join(CONTENT_ROOT, '.locks')

export const CONTENT_TYPE_DIRS: Record<ContentType, string> = {
  post: 'posts',
  note: 'notes',
  project: 'projects',
}

export const DIR_TO_CONTENT_TYPE: Record<string, ContentType> = {
  posts: 'post',
  notes: 'note',
  projects: 'project',
}

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const

/** Directories inside CONTENT_ROOT that are never scanned for documents. */
const RESERVED_DIRS = new Set(['.tmp', '.locks', '.git', 'node_modules', '.obsidian'])

export function isReservedDir(name: string): boolean {
  return RESERVED_DIRS.has(name) || name.startsWith('.')
}

export function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function typeDirectory(type: ContentType): string {
  return CONTENT_TYPE_DIRS[type]
}

/** Absolute path of the directory holding a content type. */
export function typeDirPath(type: ContentType): string {
  return assertInside(CONTENT_ROOT, path.join(CONTENT_ROOT, typeDirectory(type)))
}

/**
 * Absolute path of a document, from its POSIX path relative to CONTENT_ROOT.
 *
 * `relativePath` always comes from a database row or the scanner, but it is
 * still re-validated: a row edited directly in SQL must not become a way to
 * read or overwrite an arbitrary file.
 *
 * Both refusals are `PathSecurityError` rather than a bare `Error`, so a caller
 * at a request boundary can distinguish "this path was an attack" from "this
 * write failed" — and answer 400 rather than 500. A bare `Error` here would be
 * caught by the generic write handler in `writer.ts` and reported as an
 * ordinary save failure, which is the wrong story to tell about a path that
 * tried to leave the tree.
 */
export function documentPath(relativePath: string): string {
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalised) {
    throw new PathSecurityError('Document path is empty')
  }
  const segments = normalised.split('/').filter((s) => s && s !== '.')
  for (const segment of segments) {
    if (segment === '..') {
      throw new PathSecurityError(
        `Document path escapes the content root: ${relativePath}`,
      )
    }
  }
  return assertInside(
    CONTENT_ROOT,
    path.join(CONTENT_ROOT, ...segments),
    'document',
  )
}

/** Build the canonical relative path for a new document. */
export function buildRelativePath(
  type: ContentType,
  slug: string,
  extension = '.md',
): string {
  const filename = slug.endsWith(extension) ? slug : `${slug}${extension}`
  return toPosix(path.join(typeDirectory(type), filename))
}

/**
 * Recover the content type and slug from a path relative to CONTENT_ROOT.
 * Returns null for files outside a known type directory, which is how the
 * scanner ignores stray README files.
 */
export function parseRelativePath(
  relativePath: string,
): { type: ContentType; filename: string; slug: string } | null {
  const posix = toPosix(relativePath).replace(/^\/+/, '')
  const segments = posix.split('/')
  if (segments.length !== 2) return null

  const [dir, filename] = segments
  if (!dir || !filename) return null

  const type = DIR_TO_CONTENT_TYPE[dir]
  if (!type) return null
  if (!isMarkdownFile(filename)) return null

  const slug = filename.replace(/\.(md|markdown)$/i, '')
  return { type, filename, slug }
}

/** The writable directories that must exist before the app can serve traffic. */
export function requiredContentDirs(): string[] {
  return [
    CONTENT_ROOT,
    TMP_DIR,
    LOCK_DIR,
    ...Object.values(CONTENT_TYPE_DIRS).map((dir) =>
      path.join(CONTENT_ROOT, dir),
    ),
  ]
}

/** Path of a document's lock file. Slug is hashed to stay within name limits. */
export function lockPath(relativePath: string): string {
  const safe = relativePath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  return assertInside(LOCK_DIR, path.join(LOCK_DIR, `${safe}.lock`), 'lock file')
}

/** Path for a temporary write target. */
export function tempPath(relativePath: string): string {
  const safe = relativePath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  return assertInside(
    TMP_DIR,
    path.join(TMP_DIR, `${safe}.${unique}.tmp`),
    'temporary file',
  )
}

/** Public URL for a document. */
export function documentUrl(type: ContentType, slug: string): string {
  switch (type) {
    case 'post':
      return `/posts/${encodeURIComponent(slug)}`
    case 'note':
      return `/notes/${encodeURIComponent(slug)}`
    case 'project':
      return `/projects/${encodeURIComponent(slug)}`
  }
}
