import 'server-only'

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { env } from '@/env'
import { recordAudit } from '@/lib/audit'
import { normalizeImageKey } from '@/lib/content/links'
import { db } from '@/lib/db'
import { assets, type AssetRow, type AssetThumbnail } from '@/lib/db/schema'
import { sniffMime } from '@/lib/security/mime'
import {
  joinRuntimePath,
  resolveRelative,
  sanitizeFilename,
} from '@/lib/security/paths'

import { formatBytes } from '@/lib/utils/format'

import {
  processImage,
  type ProcessedImage,
  type SkippedDerivative,
} from './process'
import { prepareSvg } from './svg'

/**
 * Putting asset bytes on disk.
 *
 * Three properties, in the order they matter:
 *
 *   1. **The stored name comes from the bytes, not from the upload.** It is the
 *      SHA-256 of what is written plus the extension `sniffMime` derived from
 *      the same bytes. The declared MIME type and the filename are both
 *      attacker-controlled and neither is evidence, so neither is consulted.
 *      Two uploads of one file are one file on disk, and a URL that is a hash
 *      cannot be walked — there is no `1.png`, `2.png` to enumerate.
 *   2. **A reader never sees a half-written file.** The bytes go to a temporary
 *      name, are fsynced, and are `rename()`d into place. A partially written
 *      upload served as an image is a corrupted image, and it is the failure a
 *      plain `writeFile` produces on every interrupted upload.
 *   3. **Nothing outside `UPLOAD_DIR` is ever touched.** The name is ours, and
 *      the containment check still runs before the write, because the two
 *      guarantees are independent: a future caller passing a row's value
 *      straight through must not be able to escape the directory.
 *
 * `persistAsset` writes the bytes and reports where they went; `storeAsset`
 * adds the database row to them. The row is the manifest and the file is the
 * payload, and the file is written first: an unreferenced file is invisible and
 * reclaimable, whereas a row whose file is missing is a broken page.
 */

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class AssetStoreError extends Error {
  readonly code: string = 'ASSET_STORE'
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'AssetStoreError'
    this.cause = cause
  }
}

/** The bytes are not a format this store accepts. */
export class UnsupportedAssetError extends AssetStoreError {
  override readonly code = 'ASSET_UNSUPPORTED'

  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedAssetError'
  }
}

/** The upload exceeds `MAX_UPLOAD_SIZE`. */
export class AssetTooLargeError extends AssetStoreError {
  override readonly code = 'ASSET_TOO_LARGE'

  constructor(message: string) {
    super(message)
    this.name = 'AssetTooLargeError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Root of the upload tree, resolved once.
 *
 * Built through `joinRuntimePath` for the same reason as `CONTENT_ROOT`: a root
 * the bundler cannot resolve makes the file tracer assume the entire project is
 * reachable, and uploads are a mounted volume rather than part of the build.
 */
export const UPLOAD_ROOT = joinRuntimePath(process.cwd(), env.UPLOAD_DIR)

/**
 * Where in-flight writes live until they are renamed into place.
 *
 * Inside the upload root rather than in the system temp directory, so the
 * `rename()` cannot cross a filesystem boundary and degrade into a copy. The
 * names are random and short-lived, and nothing lists this directory to serve
 * it — the database is the manifest.
 */
export const UPLOAD_TMP_DIR = joinRuntimePath(UPLOAD_ROOT, '.tmp')

/** Public URL prefix without its trailing slash. */
const URL_PREFIX = env.UPLOAD_URL_PREFIX.replace(/\/+$/, '')

/** The prefix `normalizeImageKey` also understands, for links written by hand. */
const LEGACY_URL_PREFIX = '/uploads'

/** Absolute filesystem path of a stored asset, proven to stay inside the root. */
export function resolveAssetFile(relativePath: string): string {
  return resolveRelative(UPLOAD_ROOT, relativePath)
}

/** Public URL of a stored asset. */
export function assetUrl(relativePath: string): string {
  return `${URL_PREFIX}/${relativePath}`
}

/**
 * Storage key behind a URL, or null when the URL is not ours.
 *
 * Variant URLs are written with whatever prefix was configured when the asset
 * was stored, so both the current prefix and the conventional one are tried:
 * after a prefix change the files are still where they were, and a delete that
 * could not find them would leave them on disk forever.
 */
export function relativePathFromUrl(url: string): string | null {
  return (
    normalizeImageKey(url, URL_PREFIX) ??
    normalizeImageKey(url, LEGACY_URL_PREFIX)
  )
}

/** Every file an asset occupies: the original plus each derivative. */
export function assetFilePaths(
  asset: Pick<AssetRow, 'path' | 'variants' | 'thumbnail'>,
): string[] {
  const paths = new Set<string>([asset.path])
  const urls = [
    ...asset.variants.map((variant) => variant.url),
    ...(asset.thumbnail ? [asset.thumbnail.url] : []),
  ]
  for (const url of urls) {
    const relative = relativePathFromUrl(url)
    if (relative) paths.add(relative)
  }
  return [...paths]
}

/* -------------------------------------------------------------------------- */
/*  Content addressing                                                         */
/* -------------------------------------------------------------------------- */

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,8}$/

/**
 * Path of a file, from the hash of its own contents.
 *
 * Sharded two hex characters at a time. A single directory holds every upload
 * otherwise, and one directory with fifty thousand entries is slow to list, slow
 * to back up, and unpleasant to look at; two levels of two characters spread the
 * corpus across 65536 directories, which a personal blog never fills, while
 * staying shallow enough to read. Date sharding — the `2026/09/…` shape the
 * schema comment uses as an example — cannot be used here: the name is a
 * function of the bytes, so the same image uploaded in October has to land on
 * the same path as in September, or deduplication quietly stops working and the
 * file is stored twice under two URLs.
 */
export function storedRelativePath(sha256: string, ext: string): string {
  if (!HASH_PATTERN.test(sha256)) {
    throw new AssetStoreError(
      `Refusing to build a storage path from ${JSON.stringify(sha256)}: not a SHA-256 digest`,
    )
  }
  if (!EXTENSION_PATTERN.test(ext)) {
    throw new AssetStoreError(
      `Refusing to build a storage path from ${JSON.stringify(ext)}: not an extension`,
    )
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ext}`
}

/* -------------------------------------------------------------------------- */
/*  Files                                                                      */
/* -------------------------------------------------------------------------- */

let directoriesReady: Promise<void> | null = null

/** Create the upload directories once per process. */
export function ensureUploadDirectories(): Promise<void> {
  directoriesReady ??= (async () => {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true })
    await fs.mkdir(UPLOAD_TMP_DIR, { recursive: true })
  })()
  return directoriesReady
}

/**
 * Write bytes under a content-addressed name.
 *
 * Same contract as `@/lib/content/writer`: the target is never opened for
 * writing, a new file is written under `.tmp/`, fsynced, and renamed over the
 * target, and a failure leaves no partial file behind. `fsyncDirectory` is
 * duplicated from there rather than imported, because `writer.ts` keeps it
 * private and exporting it would make the content engine a dependency of the
 * asset store for twelve lines of code.
 */
async function writeAssetFile(
  relativePath: string,
  bytes: Buffer,
): Promise<{ created: boolean }> {
  const target = resolveAssetFile(relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })

  // The name is the hash of these bytes, so a file already at this path holds
  // exactly them and the write is a no-op — which is what makes two uploads of
  // one file one file. The size is compared anyway: a truncated leftover from
  // something else must not be mistaken for a completed write, and the cost of
  // finding out is one `stat`.
  const existing = await fs.stat(target).catch(() => null)
  if (existing?.isFile() && existing.size === bytes.length) {
    return { created: false }
  }

  const tmp = resolveRelative(
    UPLOAD_TMP_DIR,
    `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`,
  )

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tmp, 'wx', 0o644)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined

    await fs.rename(tmp, target)
    await fsyncDirectory(path.dirname(target))
    return { created: true }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.unlink(tmp).catch(() => undefined)
    throw new AssetStoreError(
      `Failed to write ${relativePath}: ${messageOf(error)}`,
      error,
    )
  }
}

/**
 * Remove a stored file.
 *
 * A file that is already gone is the outcome the caller wanted, so `ENOENT` is
 * not an error; anything else is reported rather than thrown, because the
 * database row is already gone by the time this runs and a failure here cannot
 * undo it. The caller decides what to do with a file it could not remove.
 */
export async function removeStoredFile(relativePath: string): Promise<{
  removed: boolean
  error?: string
}> {
  try {
    await fs.unlink(resolveAssetFile(relativePath))
    return { removed: true }
  } catch (error) {
    if (isNotFound(error)) return { removed: false }
    return { removed: false, error: messageOf(error) }
  }
}

/** Flush a directory entry so a rename survives a power loss. */
async function fsyncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch {
    // Not supported on every platform or filesystem. The rename is still
    // atomic; only crash durability is weaker.
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/* -------------------------------------------------------------------------- */
/*  Persisting                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssetVariant {
  format: string
  url: string
  size: number
}

export interface PersistedAsset {
  /** POSIX path relative to `UPLOAD_DIR`; also the key documents reference. */
  path: string
  url: string
  absolutePath: string
  /** Sniffed from the bytes. Never the upload's claim, never the filename's. */
  mime: string
  /** Size of the stored bytes, which for a re-encoded image is not the upload's. */
  size: number
  width: number | null
  height: number | null
  blurDataUrl: string | null
  sha256: string
  variants: AssetVariant[]
  /** The scaled copy written for the admin's grid, or null when none was needed. */
  thumbnail: AssetThumbnail | null
  /** The original filename, sanitised. Metadata only — never a path. */
  filename: string
  /** False when these exact bytes were already on disk; nothing was rewritten. */
  created: boolean
  averageColor: string | null
  /** What SVG sanitisation removed. Empty for every other format. */
  sanitizationRemoved: string[]
  skippedDerivatives: SkippedDerivative[]
  /** Decisions taken while preparing the bytes, in plain words. */
  notes: string[]
}

export interface PersistAssetInput {
  buffer: Buffer
  /** Kept as metadata. It does not influence the stored name or extension. */
  originalFilename?: string | null
}

/**
 * Write an upload to the store and report where it went.
 *
 * No database, no audit: this is the part that only concerns bytes, and keeping
 * it separate is what lets naming, sniffing and sanitisation be tested against
 * a temporary directory instead of a Postgres instance.
 */
export async function persistAsset(
  input: PersistAssetInput,
): Promise<PersistedAsset> {
  const { buffer } = input

  if (buffer.length === 0) {
    throw new UnsupportedAssetError('The upload is empty')
  }
  if (buffer.length > env.MAX_UPLOAD_SIZE) {
    throw new AssetTooLargeError(
      `Upload is ${formatBytes(buffer.length)}; the limit is ${formatBytes(env.MAX_UPLOAD_SIZE)}`,
    )
  }

  // The extension stored is the one derived from these bytes. `photo.zip` whose
  // contents are a PNG is a PNG, and the `.zip` never reaches a path.
  const sniff = sniffMime(buffer)
  if (!sniff.allowed) {
    throw new UnsupportedAssetError(
      `The upload is not a supported asset: ${sniff.mime} was detected from its contents`,
    )
  }

  await ensureUploadDirectories()

  const prepared =
    sniff.mime === 'image/svg+xml'
      ? await prepareSvgAsset(buffer)
      : await processImage(buffer, sniff)

  const bytes = prepared.bytes
  const sha256 = sha256Of(bytes)
  const relativePath = storedRelativePath(sha256, sniff.ext)

  const variants: AssetVariant[] = []
  let thumbnail: AssetThumbnail | null = null
  const written: string[] = []

  try {
    const original = await writeAssetFile(relativePath, bytes)
    if (original.created) written.push(relativePath)

    for (const derivative of prepared.derivatives) {
      const derivativeHash = sha256Of(derivative.bytes)
      const derivativePath = storedRelativePath(derivativeHash, derivative.ext)

      // A derivative can be byte-identical to the original — re-encoding a
      // small lossless file sometimes reproduces it exactly. Storing a second
      // copy under a second name would cost a file and save nothing.
      if (derivativePath === relativePath) {
        prepared.notes.push(
          `${derivative.format} derivative is identical to the stored original`,
        )
        continue
      }

      const write = await writeAssetFile(derivativePath, derivative.bytes)
      if (write.created) written.push(derivativePath)

      variants.push({
        format: derivative.format,
        url: assetUrl(derivativePath),
        size: derivative.bytes.length,
      })
    }

    if (prepared.thumbnail) {
      const thumbnailPath = storedRelativePath(
        sha256Of(prepared.thumbnail.bytes),
        '.webp',
      )
      const write = await writeAssetFile(thumbnailPath, prepared.thumbnail.bytes)
      if (write.created) written.push(thumbnailPath)

      thumbnail = {
        url: assetUrl(thumbnailPath),
        width: prepared.thumbnail.width,
        height: prepared.thumbnail.height,
        size: prepared.thumbnail.bytes.length,
      }
    }
  } catch (error) {
    // Only the files this call created are removed: a file that was already
    // there belongs to the asset that put it there, and another upload may
    // share the hash.
    await Promise.all(
      written.map((file) =>
        fs.unlink(resolveAssetFile(file)).catch(() => undefined),
      ),
    )
    throw error instanceof AssetStoreError
      ? error
      : new AssetStoreError(`Failed to store the upload: ${messageOf(error)}`, error)
  }

  return {
    path: relativePath,
    url: assetUrl(relativePath),
    absolutePath: resolveAssetFile(relativePath),
    mime: sniff.mime,
    size: bytes.length,
    width: prepared.width,
    height: prepared.height,
    blurDataUrl: prepared.blurDataUrl,
    sha256,
    variants,
    thumbnail,
    filename: metadataFilename(input.originalFilename, relativePath),
    created: written.includes(relativePath),
    averageColor: prepared.averageColor,
    sanitizationRemoved: prepared.sanitizationRemoved,
    skippedDerivatives: prepared.skippedDerivatives,
    notes: prepared.notes,
  }
}

/**
 * Sanitise an SVG and describe the result in the same shape as a processed
 * image, so the caller has one path to follow rather than two.
 *
 * An SVG gets no placeholder and no raster derivatives: it is already the
 * smallest form of itself at every size, and the frontend uses the one file for
 * all of them.
 */
function prepareSvgAsset(buffer: Buffer): ProcessedImage {
  const { svg, removed } = prepareSvg(buffer)
  return {
    bytes: svg,
    // A vector has no intrinsic pixels. The `width`/`height` attributes on the
    // root are the author's declared display size, not the resolution of an
    // image, so recording them as pixel dimensions would be a guess.
    width: null,
    height: null,
    blurDataUrl: null,
    averageColor: null,
    derivatives: [],
    skippedDerivatives: [],
    thumbnail: null,
    sanitizationRemoved: removed,
    notes: [
      'SVG stored after sanitisation: vectors get no blur placeholder, no raster derivatives and no thumbnail',
    ],
  }
}

/**
 * The filename to keep as metadata.
 *
 * Sanitised, because it is displayed in the admin and echoed back into pages —
 * a name carrying control characters or a path separator is a display problem
 * wherever it lands. Falls back to the stored name when the upload had none.
 */
function metadataFilename(
  originalFilename: string | null | undefined,
  storedPath: string,
): string {
  const fallback = path.basename(storedPath)
  const name = originalFilename?.trim()
  return sanitizeFilename(name && name.length > 0 ? name : fallback)
}

/* -------------------------------------------------------------------------- */
/*  Storing                                                                    */
/* -------------------------------------------------------------------------- */

export interface StoreAssetInput extends PersistAssetInput {
  /** `users.id` of whoever uploaded it. */
  ownerId?: string | null
  alt?: string | null
}

export interface StoreAssetResult {
  asset: AssetRow
  /** False when identical bytes were already stored; the existing row is returned. */
  created: boolean
  averageColor: string | null
  /** What SVG sanitisation removed, for the admin to see. */
  sanitizationRemoved: string[]
  skippedDerivatives: SkippedDerivative[]
  notes: string[]
}

/**
 * Store an upload and record it.
 *
 * A duplicate upload returns the row that is already there rather than a second
 * one: the file on disk is shared, and two rows pointing at one path would each
 * claim to own a file the other could delete. The metadata a caller sends with
 * a duplicate — a new `alt`, a different owner — is therefore *not* applied;
 * changing an existing asset is an edit, and an edit is not something an upload
 * should perform silently.
 */
export async function storeAsset(
  input: StoreAssetInput,
): Promise<StoreAssetResult> {
  const persisted = await persistAsset(input)

  const [existing] = await db
    .select()
    .from(assets)
    .where(eq(assets.sha256, persisted.sha256))
    .limit(1)

  if (existing) {
    return resultFrom(existing, persisted, false)
  }

  const [inserted] = await db
    .insert(assets)
    .values({
      path: persisted.path,
      url: persisted.url,
      filename: persisted.filename,
      mime: persisted.mime,
      size: persisted.size,
      width: persisted.width,
      height: persisted.height,
      blurDataUrl: persisted.blurDataUrl,
      sha256: persisted.sha256,
      variants: persisted.variants,
      thumbnail: persisted.thumbnail,
      alt: truncate(input.alt ?? null, 500),
      uploadedBy: input.ownerId ?? null,
    })
    // The same bytes can arrive twice at once. The file write is idempotent;
    // this keeps the row that way too, and the loser re-reads the winner's row.
    .onConflictDoNothing({ target: assets.path })
    .returning()

  if (!inserted) {
    const [raced] = await db
      .select()
      .from(assets)
      .where(eq(assets.path, persisted.path))
      .limit(1)

    if (!raced) {
      throw new AssetStoreError(
        `Insert for ${persisted.path} conflicted but no row was found`,
      )
    }
    return resultFrom(raced, persisted, false)
  }

  // Only a new row is audited. A duplicate upload changes nothing, and a log
  // that repeats itself for every re-upload of one file is a log nobody reads.
  await recordAudit({
    action: 'asset.upload',
    actorId: input.ownerId ?? null,
    targetType: 'asset',
    targetId: inserted.id,
    metadata: {
      path: inserted.path,
      mime: inserted.mime,
      size: inserted.size,
      variants: inserted.variants.length,
      thumbnail: inserted.thumbnail !== null,
    },
  })

  return resultFrom(inserted, persisted, true)
}

function resultFrom(
  asset: AssetRow,
  persisted: PersistedAsset,
  created: boolean,
): StoreAssetResult {
  return {
    asset,
    created,
    averageColor: persisted.averageColor,
    sanitizationRemoved: persisted.sanitizationRemoved,
    skippedDerivatives: persisted.skippedDerivatives,
    notes: persisted.notes,
  }
}

/** Truncate on code-point boundaries: a lone surrogate is not valid UTF-8. */
function truncate(value: string | null, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const points = [...trimmed]
  return points.length <= max ? trimmed : points.slice(0, max).join('')
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
