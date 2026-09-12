import 'server-only'

import { parseFrontmatter } from '@/lib/content/frontmatter'
import { readDocument, scanContentFiles, type ContentDocument } from '@/lib/content/reader'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { normaliseFrontmatterKeys, splitFrontmatterKeys } from '@/lib/content/schema'
import type { ContentRow } from '@/lib/db/schema'
import {
  dateKeyOf,
  formValuesFromFrontmatter,
  preservedKeys,
  type ContentFormValues,
} from './frontmatter-form'
import type { IndexDrift } from './index-drift'
import { contentRowByPath, contentRowFor } from './queries'

/**
 * Everything the editor needs about one document, assembled once.
 *
 * The panel and the writer must agree on what a save will produce, so both read
 * the frontmatter through the same normalisation the reader uses: aliases folded
 * onto canonical keys, unknown keys separated out, and the date key remembered so
 * a file written with `publishedAt:` is not silently rewritten with `date:`.
 *
 * The editor addresses documents by type and slug, which is how the site
 * addresses them too — and the index is a projection of the files, so a document
 * can exist on disk with no row, or with a row built from an earlier version of
 * it. Both are openable here, and both are marked (`IndexDrift`), because the
 * save is what repairs them: `afterWrite` in the save action tolerates a missing
 * row for exactly this reason and re-indexes the file it just wrote.
 */

export interface EditorDocument {
  type: ContentType
  slug: string
  path: string
  status: ContentStatus
  /** Checksum of the file as loaded; the save refuses if the file has moved on. */
  checksum: string
  body: string
  values: ContentFormValues
  /** Keys the panel does not own, listed read-only so nothing vanishes silently. */
  preserved: Record<string, unknown>
  dateKey: 'date' | 'publishedAt'
  /** Null when the file exists on disk but has no index row. */
  contentId: string | null
  wordCount: number
  viewCount: number
  updatedAt: Date
  /** Title the reader derived from the body, when the frontmatter has none. */
  derivedTitle: string
  /** How the index disagrees with this file, or null when it does not. */
  indexDrift: IndexDrift | null
}

function assemble(document: ContentDocument, row: ContentRow | null): EditorDocument {
  const parsed = parseFrontmatter(document.raw)
  const normalised = normaliseFrontmatterKeys(parsed.data)
  const { known } = splitFrontmatterKeys(normalised)

  return {
    type: document.type,
    slug: document.slug,
    path: document.relativePath,
    status: document.status,
    checksum: document.checksum,
    body: document.body,
    values: formValuesFromFrontmatter(normalised, { status: document.status }),
    preserved: preservedKeys(known),
    dateKey: dateKeyOf(normalised),
    contentId: row?.id ?? null,
    wordCount: row?.wordCount ?? document.wordCount,
    viewCount: row?.viewCount ?? 0,
    updatedAt: row?.updatedAt ?? document.updatedAt,
    derivedTitle: document.title,
    // The row holds the checksum of the bytes it was built from, so a file that
    // reads differently now is one the index describes an earlier version of.
    // That is a comparison the row makes possible and nothing else does: the
    // dashboard's drift count is a size-and-mtime guess, and the save's
    // `baseChecksum` only speaks for the moment the page was opened.
    indexDrift:
      row === null ? 'unindexed' : row.checksum === document.checksum ? null : 'stale',
  }
}

/**
 * Load by type and slug.
 *
 * The index is the fast path and the disk is the fallback, in that order,
 * because a document's filename is not necessarily its slug — an untitled note
 * keeps whatever name it was given — so the index is the only place the answer
 * is already computed. When it has no row, the file may still be there: added,
 * renamed or copied in outside the admin since the last sync, which is the state
 * the dashboard's drift line counts and the one an author hits after writing a
 * file by hand and opening its address. Saving one of those is already a
 * supported path — `afterWrite` has no row to attach a revision to and re-indexes
 * the file instead — so refusing to open it is the half that was missing.
 */
export async function loadEditorDocument(
  type: ContentType,
  slug: string,
): Promise<EditorDocument | null> {
  const row = await contentRowFor(type, slug)
  if (row) {
    const document = await readDocument(row.path)
    if (document) return assemble(document, row)
    // A row whose file is gone: a delete the index has not caught up with. Fall
    // through rather than 404, because the slug may now belong to the file it
    // was renamed to — which is the document this address asks for.
  }

  const path = await findPathBySlug(type, slug)
  return path === null ? null : loadDocumentByPath(path)
}

/**
 * The file that answers to `slug`, found by reading it, for the case where the
 * index has no row to ask.
 *
 * Not a path guess. A document's slug is what its frontmatter declares, or
 * failing that the slug of its title, or failing that its filename — so finding
 * a file by slug means parsing candidates the way the sync does, and a matching
 * filename is a coincidence rather than the rule. Files the reader rejects are
 * skipped rather than raised: one broken file in the tree must not turn every
 * other address into an error, and a file the sync cannot index is not one the
 * editor could save either.
 */
async function findPathBySlug(type: ContentType, slug: string): Promise<string | null> {
  for (const file of await scanContentFiles()) {
    if (file.type !== type) continue

    try {
      const document = await readDocument(file.relativePath)
      if (document?.slug === slug) return file.relativePath
    } catch {
      continue
    }
  }

  return null
}

/**
 * Load by path, with no index row required.
 *
 * The half of `loadEditorDocument`'s fallback that does the reading: by the time
 * a path is known, the row is a lookup rather than a requirement, and its
 * absence is a state the editor reports instead of a reason to refuse.
 */
export async function loadDocumentByPath(path: string): Promise<EditorDocument | null> {
  const document = await readDocument(path)
  if (!document) return null

  const row = await contentRowByPath(path)
  return assemble(document, row)
}
