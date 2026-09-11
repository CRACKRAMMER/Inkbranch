import 'server-only'

import { parseFrontmatter } from '@/lib/content/frontmatter'
import { readDocument, type ContentDocument } from '@/lib/content/reader'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { normaliseFrontmatterKeys, splitFrontmatterKeys } from '@/lib/content/schema'
import type { ContentRow } from '@/lib/db/schema'
import {
  dateKeyOf,
  formValuesFromFrontmatter,
  preservedKeys,
  type ContentFormValues,
} from './frontmatter-form'
import { contentRowByPath, contentRowFor } from './queries'

/**
 * Everything the editor needs about one document, assembled once.
 *
 * The panel and the writer must agree on what a save will produce, so both read
 * the frontmatter through the same normalisation the reader uses: aliases folded
 * onto canonical keys, unknown keys separated out, and the date key remembered so
 * a file written with `publishedAt:` is not silently rewritten with `date:`.
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
  /** True when the file is on disk but absent from the content index. */
  driftedFromIndex: boolean
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
    driftedFromIndex: row === null,
  }
}

/**
 * Load by type and slug.
 *
 * The lookup goes through the index because a document's filename is not
 * necessarily its slug — an untitled note keeps whatever name it was given, and
 * deriving `notes/<slug>.md` would fail to open files that plainly exist.
 */
export async function loadEditorDocument(
  type: ContentType,
  slug: string,
): Promise<EditorDocument | null> {
  const row = await contentRowFor(type, slug)
  if (!row) return null

  const document = await readDocument(row.path)
  if (!document) return null

  return assemble(document, row)
}

/**
 * Load by path, with no index row required.
 *
 * The editor cannot save what it cannot address, but it can still *open* a file
 * whose index row is missing — that is the state the dashboard drift warning is
 * about, and hiding those files would make the warning unactionable.
 */
export async function loadDocumentByPath(path: string): Promise<EditorDocument | null> {
  const document = await readDocument(path)
  if (!document) return null

  const row = await contentRowByPath(path)
  return assemble(document, row)
}
