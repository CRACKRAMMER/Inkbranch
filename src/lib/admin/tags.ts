import 'server-only'

import { asc, eq, inArray, sql } from 'drizzle-orm'

import { recordAudit } from '@/lib/audit'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { pruneOrphanTags, syncContent } from '@/lib/content/sync'
import { updateDocument } from '@/lib/content/writer'
import { db } from '@/lib/db'
import { contentIndex, contentTags, tags, type ContentType, type ContentStatus } from '@/lib/db/schema'
import { tagSlug } from '@/lib/utils/slug'
import { normalizeTagName } from '@/lib/utils/text'
import { captureWithPolicy } from './revisions'

/**
 * Renaming, merging and deleting tags.
 *
 * The rule that shapes this module: **a tag is derived from the files.** The
 * `tags` table is a projection of the `tags:` arrays in the frontmatter —
 * `syncTags` builds both the slug and the display name by slugifying whatever
 * the document says. So an UPDATE on `tags.name` alone would be a lie that the
 * next sync quietly corrects: the row would show the new name while every
 * document still said the old one, and a database rebuilt from the files would
 * come back the way it was. Every operation here therefore rewrites the
 * documents and lets the sync rebuild the row, which is why a "rename" is a
 * multi-file edit rather than a one-row update.
 *
 * Two consequences the UI has to state plainly, and this module cannot hide:
 *
 *   - The write is per-file atomic but not transactional across files. A file
 *     that cannot be locked or written is reported and skipped while the rest
 *     proceed, so an interrupted run leaves the corpus half-renamed. That is
 *     intentional — refusing to touch any file because one is locked would make
 *     a single stale lock block the whole operation — but it means the result
 *     is a report, not a boolean.
 *   - A rename changes a public URL: `/tag/<old-slug>` stops resolving.
 */

export interface TaggedDocument {
  id: string
  path: string
  type: ContentType
  slug: string
  title: string
  status: ContentStatus
}

/** Every document carrying one tag, at any status. */
export async function documentsWithTag(tagSlugValue: string): Promise<TaggedDocument[]> {
  const rows = await db
    .select({
      id: contentIndex.id,
      path: contentIndex.path,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
    })
    .from(contentTags)
    .innerJoin(tags, eq(tags.id, contentTags.tagId))
    .innerJoin(contentIndex, eq(contentIndex.id, contentTags.contentId))
    .where(eq(tags.slug, tagSlugValue))
    .orderBy(asc(contentIndex.type), asc(contentIndex.title))

  return rows
}

/** Documents carrying every one of `slugs`, for the "both tags present" count. */
async function documentsWithAnyTag(slugs: string[]): Promise<TaggedDocument[]> {
  if (slugs.length === 0) return []
  const rows = await db
    .selectDistinct({
      id: contentIndex.id,
      path: contentIndex.path,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
    })
    .from(contentTags)
    .innerJoin(tags, eq(tags.id, contentTags.tagId))
    .innerJoin(contentIndex, eq(contentIndex.id, contentTags.contentId))
    .where(inArray(tags.slug, slugs))

  return rows
}

export type TagRewriteMode = 'rename' | 'merge' | 'delete'

export interface TagRewriteReport {
  mode: TagRewriteMode
  /** The tag as it was, so a failure message can name what was being changed. */
  from: { slug: string; name: string }
  to: { slug: string; name: string } | null
  /** Documents actually rewritten. */
  written: { path: string; title: string; type: ContentType; slug: string }[]
  /**
   * Documents that could not be written, each with the error the writer raised.
   * Non-empty means the corpus is now inconsistent and the operation should be
   * run again.
   */
  failed: { path: string; title: string; message: string }[]
  /** Documents carrying a tag whose slug matched but whose text needed no change. */
  unchanged: number
  /** `tags` rows the sync no longer finds in any document, and their removal. */
  prunedTags: number
  /**
   * The reconciliation that follows the writes. `ok: false` means the files are
   * correct but the index still describes the old tags.
   */
  sync: { ok: boolean; message?: string; errors: number }
}

export interface TagRewriteOptions {
  mode: TagRewriteMode
  from: { slug: string; name: string }
  /** Required for `rename` and `merge`; absent for `delete`. */
  to?: { slug: string; name: string }
  actorId?: string | null
}

/**
 * Apply a tag change to every document that carries it.
 *
 * The match is on the slugified form of each frontmatter tag rather than on the
 * literal string, because that is the same comparison the sync makes: a
 * document written `tags: [javascript]` and one written `tags: [JavaScript]`
 * are the same tag, and matching the text would miss half of them.
 *
 * `updateDocument` is the only writer used, so every file goes through the same
 * lock and the same atomic replace as an editor save — and each one leaves a
 * revision behind, which is what makes a rename recoverable document by
 * document.
 */
export async function rewriteTag(options: TagRewriteOptions): Promise<TagRewriteReport> {
  const { mode, from, actorId } = options
  const to = options.to ?? null

  if (mode !== 'delete' && !to) {
    throw new Error('A rename or merge needs a destination tag.')
  }

  const documents = await documentsWithTag(from.slug)
  const report: TagRewriteReport = {
    mode,
    from,
    to,
    written: [],
    failed: [],
    unchanged: 0,
    prunedTags: 0,
    sync: { ok: true, errors: 0 },
  }

  const replacement = to ? to.name : null

  for (const document of documents) {
    let next: { data: Record<string, unknown>; body: string } | null = null

    try {
      const result = await updateDocument(document.path, (current) => {
        const parsed = parseFrontmatter(current.raw)
        const data: Record<string, unknown> = { ...parsed.data }
        // The one alias the reader folds into `tags`. Leaving it would give the
        // file two tag lists, one of which nothing reads.
        delete data.tags_string

        const currentTags = readTagList(data.tags)
        const rewritten = applyRewrite(currentTags, from.slug, replacement)

        if (sameList(currentTags, rewritten)) {
          next = null
          // Throwing is how `updateDocument` declines to write; the caller of
          // the mutate callback is this loop, which reads `next` afterwards.
          throw unchanged()
        }

        if (rewritten.length > 0) data.tags = rewritten
        else delete data.tags

        next = { data, body: parsed.content }
        return { data, body: parsed.content }
      })

      report.written.push({
        path: document.path,
        title: document.title,
        type: document.type,
        slug: document.slug,
      })

      await captureWithPolicy({
        contentId: document.id,
        type: document.type,
        slug: document.slug,
        data: next?.data ?? {},
        body: next?.body ?? '',
        previousContent: result.previousContent,
        reason: 'save',
        actorId: actorId ?? null,
      })

      await recordAudit({
        action: 'post.update',
        actorId: actorId ?? null,
        targetType: document.type,
        targetId: document.id,
        metadata: {
          type: document.type,
          slug: document.slug,
          path: document.path,
          via: `tag.${mode}`,
          tag: from.slug,
          ...(to ? { to: to.slug } : {}),
        },
      })
    } catch (error) {
      if (isUnchanged(error)) {
        report.unchanged += 1
        continue
      }
      report.failed.push({
        path: document.path,
        title: document.title,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Nothing was written, so there is nothing to reconcile — but a delete of a
  // tag that no document carries still has a row to drop, which the prune below
  // does.
  if (report.written.length > 0) {
    // One reconciliation for the whole run rather than one per file: the sync is
    // the only thing allowed to reconcile, and it is a full scan either way.
    try {
      const synced = await syncContent()
      report.sync = { ok: synced.errors.length === 0, errors: synced.errors.length }
      if (synced.errors.length > 0) {
        report.sync.message = `${synced.errors.length} file${synced.errors.length === 1 ? '' : 's'} could not be indexed.`
      }
    } catch (error) {
      report.sync = {
        ok: false,
        errors: 0,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // The old row is now referenced by nothing. `pruneOrphanTags` is the sync
  // module's own cleanup, so "orphan" means here exactly what it means there —
  // and a document that failed to write still references the tag, which is what
  // keeps its row alive for the retry.
  report.prunedTags = await pruneOrphanTags()

  return report
}

/**
 * A tag row's colour and description have no frontmatter counterpart, so a
 * rename would drop them: the old row is pruned and the sync creates the new one
 * from the documents alone. Carrying them across is the difference between a
 * rename and a rename-plus-losing-the-colour.
 */
export async function carryTagAppearance(
  fromSlug: string,
  toSlug: string,
): Promise<void> {
  const [source] = await db
    .select({ description: tags.description, color: tags.color })
    .from(tags)
    .where(eq(tags.slug, fromSlug))
    .limit(1)

  if (!source || (source.color === null && source.description === null)) return

  await db
    .update(tags)
    .set({ description: source.description, color: source.color })
    .where(eq(tags.slug, toSlug))
}

/**
 * How many documents a change would touch, and how many already carry the
 * destination tag — the number that makes a merge a merge rather than a rename.
 */
export async function tagChangeImpact(
  fromSlug: string,
  toSlug: string | null,
): Promise<{ documents: number; overlapping: number }> {
  if (!toSlug || toSlug === fromSlug) {
    const documents = await documentsWithTag(fromSlug)
    return { documents: documents.length, overlapping: 0 }
  }

  const [union, source, target] = await Promise.all([
    documentsWithAnyTag([fromSlug, toSlug]),
    documentsWithTag(fromSlug),
    documentsWithTag(toSlug),
  ])

  // Documents that already carry the destination as well as the source: for
  // these the merge removes a tag rather than changing one.
  const targetIds = new Set(target.map((row) => row.id))

  return {
    documents: union.length,
    overlapping: source.filter((row) => targetIds.has(row.id)).length,
  }
}

/** Frontmatter `tags` in any of the three spellings the reader accepts. */
function readTagList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  if (typeof value === 'string') return value.split(',')
  return [String(value)]
}

function applyRewrite(current: string[], fromSlug: string, replacement: string | null): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of current) {
    const name = normalizeTagName(raw)
    if (!name) continue

    const isTarget = tagSlug(name) === fromSlug
    if (isTarget && replacement === null) continue

    const final = isTarget && replacement !== null ? replacement : name
    const slug = tagSlug(final)
    // A merge can leave a document carrying the destination twice.
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(final)
  }

  return out
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => normalizeTagName(value) === b[index])
}

/**
 * Thrown inside the mutate callback to decline a write.
 *
 * A sentinel rather than a flag, because `updateDocument` has exactly one way
 * to say "do not write": it throws.
 */
const UNCHANGED = Symbol('tag-unchanged')

function unchanged(): Error {
  const error = new Error('unchanged')
  Object.defineProperty(error, UNCHANGED, { value: true })
  return error
}

function isUnchanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[UNCHANGED] === true
  )
}
