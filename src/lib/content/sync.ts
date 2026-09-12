import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm'
import { env } from '@/env'
import { db } from '@/lib/db'
import {
  contentIndex,
  contentLinks,
  contentTags,
  tags as tagsTable,
  type ContentRow,
} from '@/lib/db/schema'
import { SEARCH_INDEX_VERSION } from '@/lib/search/provider'
import { tagSlug } from '@/lib/utils/slug'
import { normalizeTagName } from '@/lib/utils/text'
import { extractLinks, wikiTargetCandidates, type ExtractedLinkKind } from './links'
import {
  type ContentDocument,
  parseDocument,
  scanContentFiles,
  type ContentFileStat,
} from './reader'
import { incomingKeys, pickTarget, resolveTargetKeys } from './resolve'
import type { ContentType } from './schema'

/**
 * Content Sync Engine.
 *
 * The filesystem is the source of truth, so at any moment the database index
 * may be behind it: an editor saved a file over SSH, a `git pull` landed, or a
 * container was rebuilt against a fresh volume. `syncContent` is the single
 * reconciler. Nothing else in the application is allowed to reconcile.
 *
 * Reconciliation is by checksum. mtime and size are used only as a cheap
 * pre-filter during the boot check.
 */

export interface SyncError {
  path: string
  message: string
}

export interface SyncReport {
  /** Files found on disk, within the scan bound. */
  scanned: number
  added: number
  updated: number
  deleted: number
  unchanged: number
  tagsCreated: number
  linksResolved: number
  linksBroken: number
  errors: SyncError[]
  durationMs: number
  /** True when the scan hit `CONTENT_MAX_FILES` and results are partial. */
  truncated: boolean
}

export interface SyncOptions {
  /**
   * When false, files whose mtime *and* size match the index are trusted and
   * not hashed. Used by the boot check, where reading every file would delay
   * the first request.
   */
  hashAll?: boolean
  maxFiles?: number
  /** Called for each change; useful for CLI progress output. */
  onEvent?: (event: SyncEvent) => void
}

export type SyncEvent =
  | { kind: 'added'; path: string; title: string }
  | { kind: 'updated'; path: string; title: string }
  | { kind: 'deleted'; path: string }
  | { kind: 'skipped'; path: string }
  | { kind: 'error'; path: string; message: string }

/* -------------------------------------------------------------------------- */
/*  Sync                                                                       */
/* -------------------------------------------------------------------------- */

export async function syncContent(options: SyncOptions = {}): Promise<SyncReport> {
  const started = Date.now()
  const emit = options.onEvent ?? (() => undefined)

  const report: SyncReport = {
    scanned: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    tagsCreated: 0,
    linksResolved: 0,
    linksBroken: 0,
    errors: [],
    durationMs: 0,
    truncated: false,
  }

  const files = await scanContentFiles(
    options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {},
  )
  report.scanned = files.length
  report.truncated = files.length >= (options.maxFiles ?? env.CONTENT_MAX_FILES)

  const existing = await db.select().from(contentIndex)
  const byPath = new Map(existing.map((row) => [row.path, row]))

  const seenPaths = new Set<string>()
  /** Documents parsed this run, reused for the tag and link passes. */
  const parsed: { document: ContentDocument; row: ContentRow }[] = []

  for (const file of files) {
    seenPaths.add(file.relativePath)
    const current = byPath.get(file.relativePath)

    try {
      const needsWork =
        !current ||
        current.checksum === '' ||
        options.hashAll === true ||
        current.byteSize !== file.size ||
        !sameInstant(current.fileMtime, file.mtime)

      if (!needsWork && current) {
        report.unchanged += 1
        parsed.push({ document: await loadForLinks(file, report), row: current })
        continue
      }

      const document = await parseFile(file)
      if (!document) {
        report.unchanged += 1
        continue
      }

      if (current && current.checksum === document.checksum) {
        // Content is identical; only the mtime moved. Refresh the bookkeeping
        // columns without pretending the document changed.
        const [refreshed] = await db
          .update(contentIndex)
          .set({ fileMtime: document.fileMtime, byteSize: document.byteSize })
          .where(eq(contentIndex.id, current.id))
          .returning()
        report.unchanged += 1
        if (refreshed) parsed.push({ document, row: refreshed })
        continue
      }

      if (current) {
        const [updated] = await db
          .update(contentIndex)
          .set(toRowValues(document))
          .where(eq(contentIndex.id, current.id))
          .returning()
        report.updated += 1
        emit({ kind: 'updated', path: document.relativePath, title: document.title })
        if (updated) parsed.push({ document, row: updated })
      } else {
        const [inserted] = await db
          .insert(contentIndex)
          .values({ ...toRowValues(document), type: document.type })
          .returning()
        report.added += 1
        emit({ kind: 'added', path: document.relativePath, title: document.title })
        if (inserted) parsed.push({ document, row: inserted })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.errors.push({ path: file.relativePath, message })
      emit({ kind: 'error', path: file.relativePath, message })
    }
  }

  // Anything indexed but no longer on disk.
  const missing = existing.filter((row) => !seenPaths.has(row.path))
  if (missing.length > 0) {
    await markIncomingUnresolved(missing.map((row) => row.id))
    await db.delete(contentIndex).where(
      inArray(
        contentIndex.id,
        missing.map((row) => row.id),
      ),
    )
    report.deleted = missing.length
    for (const row of missing) emit({ kind: 'deleted', path: row.path })
  }

  const tagStats = await syncTags(parsed)
  report.tagsCreated = tagStats.created

  const linkStats = await syncLinks(parsed)
  report.linksResolved = linkStats.resolved
  report.linksBroken = linkStats.broken

  report.durationMs = Date.now() - started
  return report
}

/* -------------------------------------------------------------------------- */
/*  Search staleness                                                           */
/* -------------------------------------------------------------------------- */

export interface StaleSearchRow {
  id: string
  type: ContentType
  slug: string
  path: string
  searchIndexVersion: number
}

/**
 * Rows indexed under an older search document shape.
 *
 * `SEARCH_INDEX_VERSION` exists so that adding a field to a search document is
 * a one-line change with a work list attached, instead of a silent recall loss
 * that nobody notices until a search for the new field comes back empty.
 *
 * A row is stale when its stamp is *behind*, never when it is ahead: a worker
 * running the previous release during a rolling deploy would otherwise see
 * every row it just wrote as needing rebuild, and rebuild forever.
 */
export async function findStaleSearchRows(): Promise<StaleSearchRow[]> {
  const rows = await db
    .select({
      id: contentIndex.id,
      type: contentIndex.type,
      slug: contentIndex.slug,
      path: contentIndex.path,
      searchIndexVersion: contentIndex.searchIndexVersion,
    })
    .from(contentIndex)
    .where(sql`${contentIndex.searchIndexVersion} < ${SEARCH_INDEX_VERSION}`)

  return rows
}

/**
 * How many rows are behind, without reading them.
 *
 * `findStaleSearchRows` is the work list and loads every row it names; the
 * dashboard only needs the number, and after a version bump the number is every
 * document in the corpus. Asking for a count and receiving the whole corpus is
 * the shape of query that is fine until the one day it is not.
 */
export async function countStaleSearchRows(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(contentIndex)
    .where(sql`${contentIndex.searchIndexVersion} < ${SEARCH_INDEX_VERSION}`)

  return Number(row?.value ?? 0)
}

/** Stamp the current search document version onto the given rows. */
export async function markSearchRowsIndexed(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  await db
    .update(contentIndex)
    .set({ searchIndexVersion: SEARCH_INDEX_VERSION })
    .where(inArray(contentIndex.id, ids))
  return ids.length
}

/* -------------------------------------------------------------------------- */
/*  Cheap boot check                                                           */
/* -------------------------------------------------------------------------- */

export interface BootCheckResult {
  /** True when the index and the filesystem disagree. */
  drift: boolean
  scanned: number
  indexed: number
}

/**
 * Startup check that avoids reading file contents.
 *
 * Hashes are the only reliable identity, but computing them for a few thousand
 * files would delay the first request. Comparing counts and mtimes catches the
 * realistic cases — new files, deleted files, a `git pull` that touched
 * timestamps — and a full sync is scheduled in the background when it trips.
 */
export async function checkContentDrift(): Promise<BootCheckResult> {
  const files = await scanContentFiles()
  const rows = await db
    .select({ path: contentIndex.path, mtime: contentIndex.fileMtime, size: contentIndex.byteSize })
    .from(contentIndex)

  if (files.length !== rows.length) {
    return { drift: true, scanned: files.length, indexed: rows.length }
  }

  const byPath = new Map(rows.map((row) => [row.path, row]))
  for (const file of files) {
    const row = byPath.get(file.relativePath)
    if (!row) return { drift: true, scanned: files.length, indexed: rows.length }
    if (row.size !== file.size || !sameInstant(row.mtime, file.mtime)) {
      return { drift: true, scanned: files.length, indexed: rows.length }
    }
  }

  return { drift: false, scanned: files.length, indexed: rows.length }
}

/* -------------------------------------------------------------------------- */
/*  Single-document sync                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refresh the index for one document after an admin save.
 * Targeted so a save does not trigger a full tree scan.
 */
export async function syncOneDocument(
  relativePath: string,
): Promise<{ row: ContentRow; document: ContentDocument } | null> {
  const files = await scanContentFiles()
  const file = files.find((f) => f.relativePath === relativePath)
  if (!file) {
    // The file is gone; drop the row, and leave the links that pointed at it
    // looking as broken as they now are.
    await removeFromIndex(relativePath)
    return null
  }

  const document = await parseFile(file)
  if (!document) return null

  const [current] = await db
    .select()
    .from(contentIndex)
    .where(eq(contentIndex.path, relativePath))
    .limit(1)

  let row: ContentRow | undefined
  if (current) {
    ;[row] = await db
      .update(contentIndex)
      .set(toRowValues(document))
      .where(eq(contentIndex.id, current.id))
      .returning()
  } else {
    ;[row] = await db
      .insert(contentIndex)
      .values({ ...toRowValues(document), type: document.type })
      .returning()
  }

  if (!row) return null

  await syncTags([{ document, row }])
  await syncLinks([{ document, row }])
  // The links *in* the document are settled above, against an index that now
  // contains it. This settles the links *at* it.
  await resolveIncomingLinks(row)

  return { row, document }
}

/** Remove a document from the index and from every derived table. */
export async function removeFromIndex(relativePath: string): Promise<void> {
  const [row] = await db
    .select({ id: contentIndex.id })
    .from(contentIndex)
    .where(eq(contentIndex.path, relativePath))
    .limit(1)

  if (!row) return

  await removeIndexRow(row.id)
}

/**
 * Drop one index row and everything derived from it.
 *
 * `content_tags` and `content_links` cascade from `content_index`. The one
 * thing the cascade does not do is keep `content_links.resolved` honest: the
 * foreign key nulls `target_id`, but `resolved` is a column of its own, so a
 * link that pointed at the document that just vanished would go on being
 * reported as fine by `pnpm content:links` — the command that exists to catch
 * exactly that — and nothing else would notice.
 *
 * Every delete goes through here, and the rows are flipped before the delete
 * because afterwards they are indistinguishable from rows that never resolved.
 */
async function removeIndexRow(id: string): Promise<void> {
  await markIncomingUnresolved([id])
  await db.delete(contentIndex).where(eq(contentIndex.id, id))
}

/** Mark the links pointing at these documents as pointing at nothing. */
async function markIncomingUnresolved(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(contentLinks)
    .set({ resolved: false })
    .where(inArray(contentLinks.targetId, ids))
}

/* -------------------------------------------------------------------------- */
/*  Tags                                                                       */
/* -------------------------------------------------------------------------- */

async function syncTags(
  documents: { document: ContentDocument; row: ContentRow }[],
): Promise<{ created: number }> {
  if (documents.length === 0) return { created: 0 }

  // Collect every distinct tag across the batch.
  const wanted = new Map<string, { name: string; slug: string }>()
  for (const { document } of documents) {
    for (const raw of document.tags) {
      const name = normalizeTagName(raw)
      if (!name) continue
      const slug = tagSlug(name)
      if (!slug) continue
      if (!wanted.has(slug)) wanted.set(slug, { name, slug })
    }
  }

  if (wanted.size === 0) return { created: 0 }

  const slugs = [...wanted.keys()]
  const existing = await db
    .select({ id: tagsTable.id, slug: tagsTable.slug })
    .from(tagsTable)
    .where(inArray(tagsTable.slug, slugs))

  const idBySlug = new Map(existing.map((row) => [row.slug, row.id]))
  const toCreate = slugs.filter((slug) => !idBySlug.has(slug))

  if (toCreate.length > 0) {
    const inserted = await db
      .insert(tagsTable)
      .values(
        toCreate.map((slug) => {
          const tag = wanted.get(slug)
          return { slug, name: tag?.name ?? slug }
        }),
      )
      // Two concurrent syncs could race here; the unique index makes it safe.
      .onConflictDoNothing({ target: tagsTable.slug })
      .returning({ id: tagsTable.id, slug: tagsTable.slug })

    for (const row of inserted) idBySlug.set(row.slug, row.id)

    // Anything that lost the race is fetched now.
    const stillMissing = toCreate.filter((slug) => !idBySlug.has(slug))
    if (stillMissing.length > 0) {
      const fetched = await db
        .select({ id: tagsTable.id, slug: tagsTable.slug })
        .from(tagsTable)
        .where(inArray(tagsTable.slug, stillMissing))
      for (const row of fetched) idBySlug.set(row.slug, row.id)
    }
  }

  const contentIds = documents.map(({ row }) => row.id)
  if (contentIds.length > 0) {
    await db.delete(contentTags).where(inArray(contentTags.contentId, contentIds))
  }

  const rows: { contentId: string; tagId: string }[] = []
  for (const { document, row } of documents) {
    for (const raw of document.tags) {
      const slug = tagSlug(normalizeTagName(raw))
      const tagId = idBySlug.get(slug)
      if (tagId) rows.push({ contentId: row.id, tagId })
    }
  }

  if (rows.length > 0) {
    // Deduplicate: a document listing the same tag twice would violate the PK.
    const unique = new Map(rows.map((r) => [`${r.contentId}:${r.tagId}`, r]))
    await db
      .insert(contentTags)
      .values([...unique.values()])
      .onConflictDoNothing()
  }

  return { created: toCreate.length }
}

/** Delete tags that no longer have any content attached. */
export async function pruneOrphanTags(): Promise<number> {
  const result = await db.execute(sql`
    delete from ${tagsTable}
    where not exists (
      select 1 from ${contentTags} where ${contentTags.tagId} = ${tagsTable.id}
    )
  `)
  return result.rowCount ?? 0
}

/* -------------------------------------------------------------------------- */
/*  Links                                                                      */
/* -------------------------------------------------------------------------- */

async function syncLinks(
  documents: { document: ContentDocument; row: ContentRow }[],
): Promise<{ resolved: number; broken: number }> {
  if (documents.length === 0) return { resolved: 0, broken: 0 }

  const contentIds = documents.map(({ row }) => row.id)
  await db.delete(contentLinks).where(inArray(contentLinks.sourceId, contentIds))

  // Resolve internal targets in one pass.
  const wantedKeys = new Set<string>()
  const extractedByDoc = new Map<
    string,
    ReturnType<typeof extractLinks>['links']
  >()

  for (const { document, row } of documents) {
    // `body`, not `raw`. `raw` is the whole file, frontmatter included, so the
    // YAML block would be parsed as Markdown and any link-shaped text in a
    // frontmatter value would become a link row. A `description` containing
    // `[[Note]]` is rendered as plain text everywhere on the site, so the row
    // would describe a link that no reader can click and no author can fix by
    // editing the body.
    const result = extractLinks(document.body, {
      uploadUrlPrefix: env.UPLOAD_URL_PREFIX,
      siteUrl: env.SITE_URL,
    })
    extractedByDoc.set(row.id, result.links)
    for (const link of result.links) {
      if (link.kind === 'internal') wantedKeys.add(link.targetKey)
      // A wiki link is written as a bare slug often enough that the candidates
      // have to be fetched before the resolver can pick one. Without this the
      // lookup below always misses and *every* wiki link is reported broken —
      // including links to documents that are plainly present, which is how
      // this was found.
      else if (link.kind === 'wiki') {
        for (const key of wikiTargetCandidates(link.targetKey)) {
          wantedKeys.add(key)
        }
      }
    }
  }

  const targetIdByKey = await resolveTargetKeys([...wantedKeys])

  const rows: {
    sourceId: string
    kind: ExtractedLinkKind
    href: string
    targetKey: string
    targetId: string | null
    label: string | null
    resolved: boolean
  }[] = []

  let resolved = 0
  let broken = 0

  for (const { row } of documents) {
    const links = extractedByDoc.get(row.id) ?? []
    const seen = new Set<string>()

    for (const link of links) {
      // One row per distinct (kind, target) pair; repetition is not a fact
      // worth storing twice.
      const dedupe = `${link.kind}:${link.targetKey}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)

      const targetId = pickTarget(link, targetIdByKey)?.id ?? null

      // Only these two kinds have a target to resolve. Images point at assets
      // and anchors at a heading in the same document, so neither can be
      // broken and neither is counted either way.
      const isResolvable = link.kind === 'internal' || link.kind === 'wiki'
      if (isResolvable) {
        if (targetId) resolved += 1
        else broken += 1
      }

      rows.push({
        sourceId: row.id,
        kind: link.kind,
        href: link.href.slice(0, 1024),
        targetKey: link.targetKey.slice(0, 1024),
        targetId,
        label: link.label ? link.label.slice(0, 300) : null,
        // The same predicate that fed the counters, so the stored row and the
        // reported count cannot disagree. They did: a broken wiki link was
        // counted as broken and stored as resolved, which made the backlink
        // graph claim a target that does not exist.
        resolved: isResolvable ? targetId !== null : true,
      })
    }
  }

  if (rows.length > 0) {
    // Chunk the insert so a large corpus does not exceed the parameter limit.
    const CHUNK = 500
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(contentLinks).values(rows.slice(i, i + CHUNK))
    }
  }

  return { resolved, broken }
}

/**
 * Resolve the links that were written before their target existed.
 *
 * A save resolves the links *in* the document being saved against the index as
 * it stands, which keeps the cost of a save proportional to that one document —
 * but it means a `[[reference]]` to a document nobody has written yet stays
 * unresolved, and nothing revisits it when the target finally appears. Only the
 * next full sync (a boot with `CONTENT_SYNC_ON_BOOT=1`, or an import) turned it
 * into an edge, which is the wrong half of the workflow for a wiki-style
 * corpus: writing the link first is how people write.
 *
 * The lookup is the reverse of the one above, and it uses
 * `content_links_target_key_idx`: find the unresolved rows whose spelling could
 * name this document, then keep the ones this document *wins*, by asking
 * `pickTarget` — the same function the save path and the renderer use, so the
 * three cannot drift apart. A row that already names a document is never
 * revisited: this fills nulls, it does not re-decide.
 *
 * What it cannot do is see a document that has not been indexed yet. A bare
 * `[[slug]]` that two types both claim is settled by "first candidate that
 * exists", and this resolves against the index as it stands, exactly as a save
 * does — so if the losing document is indexed first, it is the winner, and the
 * later arrival does not take the row back. That is the same ambiguity
 * `wikiTargetCandidates` declines to guess at, and the same one
 * `pnpm content:links` reports; it is not a new one.
 *
 * The rows are selected on a null `target_id` rather than on `resolved`: a
 * deletion nulls the column through its foreign key and leaves `resolved`
 * behind, and such a row is unresolved in fact and should be picked up if the
 * document comes back.
 *
 * Only the document being saved triggers this, so an import that writes a
 * corpus in arbitrary order resolves its own cross-references as it goes.
 */
async function resolveIncomingLinks(
  row: Pick<ContentRow, 'id' | 'type' | 'slug' | 'path'>,
): Promise<void> {
  const keys = incomingKeys(row)
  if (keys.length === 0) return

  const pending = await db
    .select({
      id: contentLinks.id,
      kind: contentLinks.kind,
      targetKey: contentLinks.targetKey,
    })
    .from(contentLinks)
    .where(
      and(
        isNull(contentLinks.targetId),
        inArray(contentLinks.kind, ['internal', 'wiki']),
        inArray(contentLinks.targetKey, keys),
      ),
    )

  if (pending.length === 0) return

  const wanted = new Set<string>()
  for (const link of pending) {
    if (link.kind === 'internal') wanted.add(link.targetKey)
    else for (const key of wikiTargetCandidates(link.targetKey)) wanted.add(key)
  }
  const targetIdByKey = await resolveTargetKeys([...wanted])

  const winners = pending
    .filter((link) => pickTarget(link, targetIdByKey)?.id === row.id)
    .map((link) => link.id)

  if (winners.length === 0) return

  await db
    .update(contentLinks)
    .set({ targetId: row.id, resolved: true })
    .where(inArray(contentLinks.id, winners))
}

/* -------------------------------------------------------------------------- */
/*  Row mapping                                                                */
/* -------------------------------------------------------------------------- */

function toRowValues(document: ContentDocument) {
  return {
    slug: document.slug,
    path: document.relativePath,
    title: document.title,
    description: document.description || null,
    status: document.status,
    category: document.category,
    publishedAt: document.publishedAt,
    scheduledAt: document.scheduledAt,
    updatedAt: document.updatedAt,
    checksum: document.checksum,
    wordCount: document.wordCount,
    readingTime: document.readingTime,
    byteSize: document.byteSize,
    fileMtime: document.fileMtime,
    cover: document.cover,
    featured: document.featured,
    toc: document.toc,
    lang: document.lang,
    series: document.series,
    headings: document.headings,
    seoTitle: document.seo.title,
    seoDescription: document.seo.description,
    canonicalUrl: document.seo.canonical,
    ogImage: document.seo.ogImage,
    noindex: document.seo.noindex,
    projectStatus: document.projectStatus,
    repoUrl: document.repoUrl,
    websiteUrl: document.websiteUrl,
    techStack: document.techStack,
    startedAt: document.startedAt ? document.startedAt.toISOString().slice(0, 10) : null,
    extra: document.extra,
    searchIndexVersion: SEARCH_INDEX_VERSION,
  } satisfies Partial<typeof contentIndex.$inferInsert>
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function parseFile(file: ContentFileStat): Promise<ContentDocument | null> {
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(file.absolutePath, 'utf8')
  return parseDocument({
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    raw,
    stat: { mtime: file.mtime, size: file.size },
  })
}

/** Read a document during the unchanged path, tolerating a parse failure. */
async function loadForLinks(
  file: ContentFileStat,
  report: SyncReport,
): Promise<ContentDocument> {
  try {
    const document = await parseFile(file)
    if (document) return document
  } catch (error) {
    report.errors.push({
      path: file.relativePath,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  // A placeholder keeps the batch aligned; its links simply resolve to nothing.
  return placeholderDocument(file)
}

function placeholderDocument(file: ContentFileStat): ContentDocument {
  return {
    type: file.type,
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    filename: file.filename,
    slug: file.filename.replace(/\.(md|markdown)$/i, ''),
    title: file.filename,
    description: '',
    status: 'draft',
    category: null,
    tags: [],
    series: null,
    lang: 'en',
    publishedAt: null,
    scheduledAt: null,
    updatedAt: file.mtime,
    fileMtime: file.mtime,
    cover: null,
    featured: false,
    toc: false,
    seo: {
      title: null,
      description: null,
      canonical: null,
      ogImage: null,
      noindex: true,
    },
    headings: [],
    wordCount: 0,
    readingTime: 0,
    projectStatus: null,
    startedAt: null,
    repoUrl: null,
    websiteUrl: null,
    techStack: [],
    extra: {},
    body: '',
    raw: '',
    plainText: '',
    checksum: '',
    byteSize: file.size,
  }
}

/** Compare two instants at second resolution; Postgres timestamps have µs. */
function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return a === b
  return Math.abs(a.getTime() - b.getTime()) < 1000
}
