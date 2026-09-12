import 'server-only'

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  like,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { documentUrl } from '@/lib/content/paths'
import { db } from '@/lib/db'
import {
  assets,
  contentIndex,
  contentLinks,
  siteSettings,
  type AssetRow,
  type ContentStatus,
  type ContentType,
} from '@/lib/db/schema'

import { assetFilePaths, relativePathFromUrl, removeStoredFile } from './storage'

/**
 * Listing, deleting and accounting for assets.
 *
 * The rule this module exists to hold: **deleting an asset must not quietly
 * break a page.** A delete therefore refuses by default when anything still
 * points at the asset, and says what pointed at it. Deleting something in use is
 * still possible — a forced delete is the right answer for a typo'd upload that
 * a draft mentions — but it takes an explicit `force`, so the safe call is the
 * one a caller writes by accident.
 *
 * A reference can live in three places, and all three are checked:
 *
 *   - `content_links` rows, which is what the Markdown scanner produced;
 *   - a document's `cover`/`og_image` frontmatter, which the scanner never sees
 *     because `extractLinks` reads Markdown links and frontmatter is not one;
 *   - `site_settings.avatar_url`.
 *
 * Missing the second one is the subtle failure: an image used only as a post's
 * cover would look unused, and the cleanup pass would delete a hero image.
 */

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class AssetQueryError extends Error {
  readonly code = 'ASSET_QUERY'

  constructor(message: string) {
    super(message)
    this.name = 'AssetQueryError'
  }
}

export class AssetNotFoundError extends Error {
  readonly code = 'ASSET_NOT_FOUND'

  constructor(readonly assetId: string) {
    super(`No asset with id ${assetId}`)
    this.name = 'AssetNotFoundError'
  }
}

/**
 * Thrown when a delete was refused because documents still reference the asset.
 *
 * The usage travels on the error rather than in a message, so a route handler
 * can render the list of documents in the refusal without a second query.
 */
export class AssetInUseError extends Error {
  readonly code = 'ASSET_IN_USE'

  constructor(readonly usage: AssetUsage) {
    super(
      `Asset ${usage.asset.path} is still referenced by ${usage.documents.length} document(s)` +
        (usage.usedAsSiteAvatar ? ' and is the site avatar' : '') +
        '; pass force to delete it anyway',
    )
    this.name = 'AssetInUseError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export const ASSET_TYPES = [
  'all',
  'image',
  'svg',
  'video',
  'document',
  'other',
] as const

export type AssetTypeFilter = (typeof ASSET_TYPES)[number]

const SVG_MIME = 'image/svg+xml'
const PDF_MIME = 'application/pdf'

const assetIdSchema = z.uuid()

const listAssetsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
  /** Coarse kind, derived from the sniffed MIME — never from the filename. */
  type: z.enum(ASSET_TYPES).default('all'),
})

export type ListAssetsInput = z.input<typeof listAssetsSchema>

export interface AssetPage {
  items: AssetRow[]
  /** Rows matching the filters, ignoring `limit` and `offset`. */
  total: number
}

/**
 * One page of assets, newest first.
 *
 * `search` matches the stored filename and the alt text, which are the two
 * things an admin recognises a file by. Matching the path would be matching a
 * hash, and matching the MIME type is what `type` is for.
 */
export async function listAssets(input: ListAssetsInput = {}): Promise<AssetPage> {
  const parsed = listAssetsSchema.safeParse(input)
  if (!parsed.success) {
    throw new AssetQueryError(issueSummary(parsed.error.issues))
  }

  const { limit, offset, search, type } = parsed.data
  const where = and(typeCondition(type), searchCondition(search))

  const items = await db
    .select()
    .from(assets)
    .where(where)
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(limit)
    .offset(offset)

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(assets)
    .where(where)

  return { items, total: counted?.total ?? 0 }
}

export interface AssetStorage {
  files: number
  /** Summed `assets.size` — the originals, not the derivatives beside them. */
  bytes: number
}

/**
 * What the library costs, across every asset rather than one page of them.
 *
 * The assets screen reports "On this page", which is the right number for that
 * screen and the wrong one for a storage figure: a status line that said 4 MiB
 * because the page size is 24 would be a lie that looks like a measurement.
 *
 * The derivatives — thumbnails, variants — are files on disk that this does not
 * count. They are a function of the originals and are not stored as byte sizes
 * in a column that can be summed, so the figure is stated as what it is: the
 * originals. Anything else would be a guess dressed as a total.
 */
export async function assetStorage(): Promise<AssetStorage> {
  const [row] = await db
    .select({
      files: sql<number>`count(*)::int`,
      /*
       * `bigint`, and typed as the string it really is. A library past 2 GiB
       * overflows the `integer` a `sum` of `integer` would be cast back to, and
       * node-postgres hands a `bigint` over as text rather than losing precision
       * to a double. `Number` after that is exact to 8 PiB, which is the point
       * at which this site has a different problem.
       */
      bytes: sql<string>`coalesce(sum(${assets.size}), 0)::bigint`,
    })
    .from(assets)

  return { files: row?.files ?? 0, bytes: Number(row?.bytes ?? 0) }
}

export async function getAsset(id: string): Promise<AssetRow | null> {
  const assetId = parseAssetId(id)
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  return row ?? null
}

function typeCondition(type: AssetTypeFilter) {
  switch (type) {
    case 'image':
      // SVG is an image MIME type and is not an image here: it is handled by
      // the sanitiser, has no dimensions, and no derivatives. Tabs that mixed
      // it in would hide the distinction the store works to keep.
      return and(like(assets.mime, 'image/%'), ne(assets.mime, SVG_MIME))
    case 'svg':
      return eq(assets.mime, SVG_MIME)
    case 'video':
      return like(assets.mime, 'video/%')
    case 'document':
      return eq(assets.mime, PDF_MIME)
    case 'other': {
      // `or` is typed as possibly-undefined because it accepts possibly-
      // undefined arguments; all three of these are always present.
      const recognised = or(
        like(assets.mime, 'image/%'),
        like(assets.mime, 'video/%'),
        eq(assets.mime, PDF_MIME),
      )
      return recognised ? not(recognised) : undefined
    }
    case 'all':
      return undefined
  }
}

function searchCondition(search: string | undefined) {
  if (!search) return undefined
  const pattern = likePattern(search)
  return or(ilike(assets.filename, pattern), ilike(assets.alt, pattern))
}

/**
 * Wrap a search term for `ILIKE`.
 *
 * `%` and `_` are wildcards to SQL and characters to whoever typed them, so
 * they are escaped. Backslash is already the default escape character in a
 * `LIKE` pattern, which is why no `ESCAPE` clause is needed.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function parseAssetId(id: string): string {
  const parsed = assetIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new AssetQueryError(`Not an asset id: ${JSON.stringify(id)}`)
  }
  return parsed.data
}

function issueSummary(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/* -------------------------------------------------------------------------- */
/*  References                                                                 */
/* -------------------------------------------------------------------------- */

export interface ReferencingDocument {
  id: string
  type: ContentType
  slug: string
  title: string
  status: ContentStatus
  /** Where the reference lives: a Markdown link, or a frontmatter image. */
  via: 'link' | 'cover' | 'ogImage'
  /** Route to the document, so the admin can open it before deciding. */
  href: string
}

export interface AssetUsage {
  asset: AssetRow
  documents: ReferencingDocument[]
  /** `site_settings.avatar_url` points at this asset. There is no document. */
  usedAsSiteAvatar: boolean
}

export function isAssetInUse(
  usage: Pick<AssetUsage, 'documents' | 'usedAsSiteAvatar'>,
): boolean {
  return usage.documents.length > 0 || usage.usedAsSiteAvatar
}

/**
 * Every key a document can use to reference this asset.
 *
 * A reference is stored as the asset's *storage key* — the path relative to the
 * upload root — because that is what `extractLinks` normalises a Markdown image
 * URL into before the row is written. The derivatives are included as well as
 * the original: a `<picture>` element can point at the AVIF or WebP and at
 * nothing else, and an asset whose only reference is a derivative would
 * otherwise be reported as unused, then deleted out from under a working page.
 *
 * The thumbnail counts too, though nothing in the product writes a reference to
 * it: any file this asset is served as can be pasted into a document — its URL
 * is printed on the asset's own page — and while the check is one more string to
 * look for, the failure it prevents is a page whose image has been deleted. A
 * file that is referenced is referenced, whichever of its files was pasted.
 */
export function referenceMatchKeys(
  asset: Pick<AssetRow, 'path' | 'url' | 'variants' | 'thumbnail'>,
): string[] {
  const keys = new Set<string>([asset.path])
  for (const url of assetUrls(asset)) {
    const key = relativePathFromUrl(url)
    if (key) keys.add(key)
  }
  return [...keys]
}

/** Every URL this asset is served or described by. */
function assetUrls(
  asset: Pick<AssetRow, 'url' | 'variants' | 'thumbnail'>,
): string[] {
  return [
    asset.url,
    ...asset.variants.map((variant) => variant.url),
    ...(asset.thumbnail ? [asset.thumbnail.url] : []),
  ]
}

/**
 * The URL-ish forms a frontmatter image field can hold.
 *
 * Covers and OG images are written by hand, so they may be the public URL or,
 * less often, the storage path itself. Both are matched.
 */
function referenceForms(asset: AssetRow): string[] {
  return [...new Set([...assetUrls(asset), ...referenceMatchKeys(asset)])]
}

/** Documents and settings that point at this asset. */
export async function findAssetReferences(
  id: string,
): Promise<AssetUsage | null> {
  const asset = await getAsset(id)
  if (!asset) return null
  return collectUsage(asset)
}

async function collectUsage(asset: AssetRow): Promise<AssetUsage> {
  const keys = referenceMatchKeys(asset)

  const linked = await db
    .select({
      id: contentIndex.id,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
    })
    .from(contentLinks)
    .innerJoin(contentIndex, eq(contentLinks.sourceId, contentIndex.id))
    .where(
      and(
        eq(contentLinks.kind, 'image'),
        or(
          eq(contentLinks.assetId, asset.id),
          keys.length > 0 ? inArray(contentLinks.targetKey, keys) : undefined,
        ),
      ),
    )

  const forms = referenceForms(asset)
  const covered = forms.length > 0
    ? await db
        .select({
          id: contentIndex.id,
          type: contentIndex.type,
          slug: contentIndex.slug,
          title: contentIndex.title,
          status: contentIndex.status,
          cover: contentIndex.cover,
          ogImage: contentIndex.ogImage,
        })
        .from(contentIndex)
        .where(
          or(
            inArray(contentIndex.cover, forms),
            inArray(contentIndex.ogImage, forms),
          ),
        )
    : []

  const documents = new Map<string, ReferencingDocument>()

  for (const row of linked) {
    documents.set(`${row.id}:link`, {
      id: row.id,
      type: row.type,
      slug: row.slug,
      title: row.title,
      status: row.status,
      via: 'link',
      href: documentUrl(row.type, row.slug),
    })
  }

  for (const row of covered) {
    // A document can reference the same asset as both its cover and its OG
    // image, and it is the document the admin cares about, not the field — but
    // the field is worth naming, because removing the wrong one leaves the
    // other pointing at a file that is about to disappear.
    if (forms.includes(row.cover ?? '')) {
      documents.set(`${row.id}:cover`, {
        id: row.id,
        type: row.type,
        slug: row.slug,
        title: row.title,
        status: row.status,
        via: 'cover',
        href: documentUrl(row.type, row.slug),
      })
    }
    if (forms.includes(row.ogImage ?? '')) {
      documents.set(`${row.id}:ogImage`, {
        id: row.id,
        type: row.type,
        slug: row.slug,
        title: row.title,
        status: row.status,
        via: 'ogImage',
        href: documentUrl(row.type, row.slug),
      })
    }
  }

  return {
    asset,
    documents: [...documents.values()],
    usedAsSiteAvatar: await isSiteAvatar(forms),
  }
}

async function isSiteAvatar(forms: string[]): Promise<boolean> {
  if (forms.length === 0) return false
  const [settings] = await db
    .select({ avatarUrl: siteSettings.avatarUrl })
    .from(siteSettings)
    .limit(1)
  return Boolean(settings?.avatarUrl && forms.includes(settings.avatarUrl))
}

/* -------------------------------------------------------------------------- */
/*  Deleting                                                                   */
/* -------------------------------------------------------------------------- */

export interface DeleteAssetOptions {
  /** Delete even when documents still reference the asset. */
  force?: boolean
  /** `users.id` of whoever asked, for the audit row. */
  actorId?: string | null
}

export interface DeleteAssetResult {
  asset: AssetRow
  /** Reported even for a forced delete, so the caller can warn the author. */
  usage: AssetUsage
  forced: boolean
  filesRemoved: string[]
  /** Files that could not be removed, with the reason. Not fatal. */
  fileErrors: { path: string; message: string }[]
}

/**
 * Delete an asset and its files.
 *
 * Refuses without `force` when anything still references the asset, and refuses
 * with an `AssetInUseError` that carries the referencing documents so the caller
 * can show them. The order of the two deletes is deliberate: **row first, then
 * files.**
 *
 * If the row is removed and a file is left behind, the file is invisible — the
 * database is the manifest and nothing lists the upload directory — so the worst
 * case is a stray file that a later sweep can reclaim. If the files went first
 * and the row delete then failed, every page showing the asset would be broken
 * while the admin still listed it as present. One failure wastes bytes; the
 * other breaks the site.
 *
 * Shard directories are left in place. Removing them would race with a
 * concurrent upload writing into the same shard, and an empty directory costs
 * nothing.
 */
export async function deleteAsset(
  id: string,
  options: DeleteAssetOptions = {},
): Promise<DeleteAssetResult> {
  const asset = await getAsset(id)
  if (!asset) throw new AssetNotFoundError(parseAssetId(id))

  const usage = await collectUsage(asset)

  if (isAssetInUse(usage) && !options.force) {
    await recordAudit({
      action: 'asset.delete',
      actorId: options.actorId ?? null,
      targetType: 'asset',
      targetId: asset.id,
      outcome: 'denied',
      metadata: {
        path: asset.path,
        documents: usage.documents.length,
        usedAsSiteAvatar: usage.usedAsSiteAvatar,
      },
    })
    throw new AssetInUseError(usage)
  }

  const files = assetFilePaths(asset)

  const deleted = await db
    .delete(assets)
    .where(eq(assets.id, asset.id))
    .returning({ id: assets.id })

  if (deleted.length === 0) {
    // Another request deleted it between the read and this write.
    throw new AssetNotFoundError(asset.id)
  }

  const filesRemoved: string[] = []
  const fileErrors: { path: string; message: string }[] = []

  for (const file of files) {
    const outcome = await removeStoredFile(file)
    if (outcome.removed) {
      filesRemoved.push(file)
    } else if (outcome.error) {
      fileErrors.push({ path: file, message: outcome.error })
    }
  }

  await recordAudit({
    action: 'asset.delete',
    actorId: options.actorId ?? null,
    targetType: 'asset',
    targetId: asset.id,
    metadata: {
      path: asset.path,
      mime: asset.mime,
      size: asset.size,
      forced: options.force === true,
      documents: usage.documents.length,
      usedAsSiteAvatar: usage.usedAsSiteAvatar,
      filesRemoved: filesRemoved.length,
      fileErrors: fileErrors.length,
    },
  })

  return {
    asset,
    usage,
    forced: options.force === true,
    filesRemoved,
    fileErrors,
  }
}

/* -------------------------------------------------------------------------- */
/*  Alt text                                                                   */
/* -------------------------------------------------------------------------- */

export interface UpdateAssetAltOptions {
  /** `users.id` of whoever asked, for the audit row. */
  actorId?: string | null
}

/**
 * Set an asset's alt text.
 *
 * Lives here rather than in the action because this is where the other asset
 * audits are, and because alt text is the one field an author can be *required*
 * to fix after the fact — a missing or wrong description is invisible on the
 * page and the only thing a screen reader has. An edit that rewrites it is worth
 * a row in the log even though it touches no files.
 *
 * `''` becomes `null`: an empty string and an absent description are the same
 * thing to every reader, and storing both would make "has alt text" a question
 * with two answers.
 *
 * Returns null when there is no such asset, which the caller turns into a
 * message — a stale dialog is the ordinary way to reach that, not an error.
 */
export async function updateAssetAlt(
  id: string,
  alt: string,
  options: UpdateAssetAltOptions = {},
): Promise<{ id: string; path: string; alt: string | null } | null> {
  const next = alt.trim() === '' ? null : alt

  const [updated] = await db
    .update(assets)
    .set({ alt: next })
    .where(eq(assets.id, id))
    .returning({ id: assets.id, path: assets.path, alt: assets.alt })

  if (!updated) return null

  await recordAudit({
    action: 'asset.update',
    actorId: options.actorId ?? null,
    targetType: 'asset',
    targetId: updated.id,
    metadata: {
      path: updated.path,
      field: 'alt',
      // The text itself is not the point of the row — that it was set, and by
      // whom, is. The length says whether a description was written or cleared.
      cleared: updated.alt === null,
      length: updated.alt?.length ?? 0,
    },
  })

  return updated
}

/* -------------------------------------------------------------------------- */
/*  Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

const findUnusedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

/** Assets nothing points at, oldest first. A proposal, not a delete. */
export async function findUnusedAssets(
  options: { limit?: number } = {},
): Promise<AssetRow[]> {
  const parsed = findUnusedSchema.safeParse(options)
  if (!parsed.success) {
    throw new AssetQueryError(issueSummary(parsed.error.issues))
  }
  const { limit } = parsed.data

  const referenced = await referencedKeySet()
  const unused: AssetRow[] = []

  // Batched rather than one query with a `NOT IN`, because "referenced" has to
  // mean the same thing here as it does in `deleteAsset`, and half of a
  // reference lives in the URLs on the row — `assets.variants` and
  // `assets.thumbnail`, both jsonb. Recovering the storage key from those URLs in
  // SQL would be `normalizeImageKey` written a second time, in a different
  // language, free to drift. The referenced set is one entry per image link in
  // the corpus, so this is a hash lookup per asset.
  const BATCH = 500
  for (let offset = 0; unused.length < limit; offset += BATCH) {
    const batch = await db
      .select()
      .from(assets)
      .orderBy(asc(assets.createdAt), asc(assets.id))
      .limit(BATCH)
      .offset(offset)

    if (batch.length === 0) break

    for (const asset of batch) {
      if (!referenceMatchKeys(asset).some((key) => referenced.has(key))) {
        unused.push(asset)
      }
    }
  }

  return unused.slice(0, limit)
}

async function referencedKeySet(): Promise<Set<string>> {
  const keys = new Set<string>()

  const imageLinks = await db
    .selectDistinct({ targetKey: contentLinks.targetKey })
    .from(contentLinks)
    .where(eq(contentLinks.kind, 'image'))

  for (const row of imageLinks) keys.add(row.targetKey)

  const frontmatter = await db
    .select({ cover: contentIndex.cover, ogImage: contentIndex.ogImage })
    .from(contentIndex)

  for (const row of frontmatter) {
    for (const value of [row.cover, row.ogImage]) {
      if (value) keys.add(relativePathFromUrl(value) ?? value)
    }
  }

  const [settings] = await db
    .select({ avatarUrl: siteSettings.avatarUrl })
    .from(siteSettings)
    .limit(1)

  if (settings?.avatarUrl) {
    keys.add(relativePathFromUrl(settings.avatarUrl) ?? settings.avatarUrl)
  }

  return keys
}
