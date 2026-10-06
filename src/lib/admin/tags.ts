import 'server-only'

import { asc, eq, inArray } from 'drizzle-orm'

import { recordAudit, type AuditAction } from '@/lib/audit'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { pruneOrphanTags, syncContent } from '@/lib/content/sync'
import { updateDocument } from '@/lib/content/writer'
import { discardRecoverySnapshot } from '@/lib/content/recovery'
import { db } from '@/lib/db'
import { contentIndex, contentTags, tags, type ContentType, type ContentStatus } from '@/lib/db/schema'
import { tagSlug } from '@/lib/utils/slug'
import { normalizeTagName } from '@/lib/utils/text'
import { captureWithPolicy } from '@/lib/revision/policy'
import type { TagChangeImpact } from './tag-impact'

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
 * The rule has one exception, where it cannot apply because there is nothing to
 * derive from: a tag no document carries. Its row is then the only copy of the
 * tag, so a rename renames the row — see the branch in `rewriteTag`.
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

/**
 * Documents carrying any one of `slugs` — the union a merge touches, counted
 * once each however many of the tags they carry.
 */
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

/**
 * The three operations, as the audit actions that name them.
 *
 * A template — `tag.${mode}` — would produce the same strings in less space,
 * and it is what this file used until the vocabulary scan caught it: that scan
 * is a grep for the literal `'tag.merge'`, so an interpolated name is an action
 * no source file appears to write. It reported the two actions reachable only
 * through the template, and a reader grepping the log's vocabulary would have
 * found nothing to read. Spelled out, both the scan and the reader find them.
 *
 * `Record<TagRewriteMode, AuditAction>` rather than three constants, so adding
 * a fourth mode is a type error here rather than a silently unwritten action.
 */
const TAG_ACTIONS: Record<TagRewriteMode, AuditAction> = {
  rename: 'tag.rename',
  merge: 'tag.merge',
  delete: 'tag.delete',
}

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
   * The `tags` row itself was renamed, rather than rebuilt from rewritten
   * documents. True only when no document carried the tag, which is the one
   * case where the row is the tag rather than a projection of the files.
   */
  renamedRow: boolean
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
    renamedRow: false,
    sync: { ok: true, errors: 0 },
  }

  const replacement = to ? to.name : null

  /**
   * A tag nothing carries, renamed.
   *
   * The rule at the top of this file is that a tag is derived from the files,
   * so an operation rewrites documents and lets the sync rebuild the row. With
   * no documents there is nothing to derive from and nothing to rewrite, which
   * leaves the row as the *only* copy of the tag — its name, and a `color` and
   * `description` that have no frontmatter counterpart, which is the whole
   * reason `carryTagAppearance` exists.
   *
   * So this branch is where the rule stops applying, and it has to be stated
   * because the general path is actively wrong here: the prune at the end of
   * this function drops rows no document links to, and it is right to for a
   * delete or a merge — the row is meant to go. For a rename it dropped the row
   * while the sync (skipped, because nothing was written) never created the new
   * one, so the tag and its appearance disappeared and the operator was told
   * the rename had succeeded.
   *
   * The prune is skipped on this path, which is a consequence of the row being
   * the thing being renamed: it would drop the row we just wrote. Other orphan
   * rows then wait for the next operation that reaches the prune, which is what
   * they already do — nothing else in the application prunes them.
   */
  if (mode === 'rename' && to && documents.length === 0) {
    await db.update(tags).set({ slug: to.slug, name: to.name }).where(eq(tags.slug, from.slug))
    report.renamedRow = true
    await recordAudit({
      action: TAG_ACTIONS.rename,
      actorId: actorId ?? null,
      targetType: 'tag',
      targetId: from.slug,
      metadata: { from: from.slug, to: to.slug, name: to.name, documents: 0, rowOnly: true },
    })
    return report
  }

  for (const document of documents) {
    // What the callback decided to write, carried out of it. A holder object
    // rather than a `let`: the assignment happens inside a closure, and the
    // compiler is right not to believe it ran.
    const written: { next: { data: Record<string, unknown>; body: string } | null } = {
      next: null,
    }
    let recoveryPath: string | undefined

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
          written.next = null
          // Throwing is how a mutate callback declines to write; nothing has
          // touched the file when it does.
          throw unchanged()
        }

        if (rewritten.length > 0) data.tags = rewritten
        else delete data.tags

        written.next = { data, body: parsed.content }
        return { data, body: parsed.content }
      }, { preservePrevious: true })
      recoveryPath = result.recoveryPath

      report.written.push({
        path: document.path,
        title: document.title,
        type: document.type,
        slug: document.slug,
      })

      const revision = await captureWithPolicy({
        contentId: document.id,
        type: document.type,
        slug: document.slug,
        data: written.next?.data ?? {},
        body: written.next?.body ?? '',
        previousContent: result.previousContent,
        reason: 'save',
        actorId: actorId ?? null,
      })
      if (revision.error) throw new Error(`Markdown was saved but revision capture failed. Previous bytes: ${result.recoveryPath ?? 'none'}`)

      await recordAudit({
        action: 'post.update',
        actorId: actorId ?? null,
        targetType: document.type,
        targetId: document.id,
        metadata: {
          type: document.type,
          slug: document.slug,
          path: document.path,
          // The operation's own action, not a second spelling of it: the row
          // written below for the operation and this per-document row are read
          // together, and deriving both from one map is what stops them
          // disagreeing about which operation they are.
          via: TAG_ACTIONS[mode],
          tag: from.slug,
          ...(to ? { to: to.slug } : {}),
        },
      })
      await discardRecoverySnapshot(result.recoveryPath)
    } catch (error) {
      if (isUnchanged(error)) {
        report.unchanged += 1
        continue
      }
      report.failed.push({
        path: document.path,
        title: document.title,
        message: `${error instanceof Error ? error.message : String(error)}${recoveryPath ? ` Markdown was saved; previous bytes are retained at ${recoveryPath}.` : ''}`,
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

  // One row for the operation, in addition to the `post.update` row each
  // rewritten document already wrote. Those rows say which files changed; this
  // one says that the operation happened at all, which is otherwise invisible
  // whenever it changes nothing — and the operation is what the operator chose
  // and what the audit log is asked about.
  await recordAudit({
    action: TAG_ACTIONS[mode],
    actorId: actorId ?? null,
    targetType: 'tag',
    targetId: from.slug,
    metadata: {
      from: from.slug,
      ...(to ? { to: to.slug } : {}),
      documents: report.written.length,
      failed: report.failed.length,
      unchanged: report.unchanged,
    },
  })

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
 *
 * Counted before the button is pressed, not after: a merge rewrites the
 * frontmatter of every document carrying the tag, and an operator deciding
 * about that needs the count, not an upper bound. `documents` is the union
 * rather than the sum for the same reason — two tags that overlap would
 * otherwise be counted twice, which is exactly the case where the decision is
 * interesting.
 *
 * The shape is declared in `./tag-impact` beside the sentence it is rendered
 * into, so that the number and the words about it cannot drift apart.
 */
export async function tagChangeImpact(
  fromSlug: string,
  toSlug: string | null,
): Promise<TagChangeImpact> {
  if (!toSlug || toSlug === fromSlug) {
    const documents = await documentsWithTag(fromSlug)
    return { documents: documents.length, carrying: documents.length, overlapping: 0 }
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
    carrying: source.length,
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
