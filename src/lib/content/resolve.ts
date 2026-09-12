import { and, eq, inArray, or } from 'drizzle-orm'

import { db } from '@/lib/db'
import { contentIndex, type ContentRow } from '@/lib/db/schema'

import { parseInternalTarget, wikiTargetCandidates, type ExtractedLinkKind } from './links'
import { CONTENT_TYPE_DIRS, documentUrl, MARKDOWN_EXTENSIONS } from './paths'
import type { ContentType } from './schema'

/**
 * Which document a link names, given the content index.
 *
 * ## Why this is a module of its own
 *
 * Two halves of the application ask this question and they have to get the same
 * answer. The sync engine asks it to write `content_links.target_id` — the edge
 * that backlinks, related content and the knowledge graph are built from. The
 * renderer asks it to turn `[[a wiki link]]` into an `<a href>`, because on the
 * page a wiki link that names a document has to *be* a link. Two predicates that
 * disagreed would put a link on the page that the database calls broken, or a
 * resolved edge whose target the reader cannot click; they did once, and the
 * point of the module is that they cannot.
 *
 * Nothing here reads `content/` — the index is the whole input — so a request
 * may call it as freely as a sync does.
 */

/**
 * A document a link named.
 *
 * The `url` is carried rather than left to the caller because every caller wants
 * one, and building it from `type` and `slug` at each call site is how the
 * two spellings of a route end up in one codebase.
 */
export interface ResolvedTarget {
  id: string
  type: ContentType
  slug: string
  /** The route the site serves it at. */
  url: string
}

/**
 * Which document a link points at, given the index.
 *
 * One expression, used from both directions: when a document is saved it
 * settles the links *in* that document, and when a document appears it settles
 * the links *at* it (`resolveIncomingLinks`). They have to agree. When two
 * predicates disagreed, a broken wiki link was counted as broken and stored as
 * resolved, and the backlink graph claimed a target that did not exist.
 *
 * A wiki target may name its type or may be a bare slug, and only this layer has
 * the index needed to settle a bare one — hence the lookup rather than a direct
 * `get`.
 */
export function pickTarget(
  link: { kind: ExtractedLinkKind; targetKey: string },
  byKey: ReadonlyMap<string, ResolvedTarget>,
): ResolvedTarget | null {
  if (link.kind === 'internal') return byKey.get(link.targetKey) ?? null
  if (link.kind !== 'wiki') return null
  return (
    wikiTargetCandidates(link.targetKey)
      .map((key) => byKey.get(key))
      .find((target) => target !== undefined) ?? null
  )
}

/** A document's path without its Markdown extension. */
function pathStem(path: string): string {
  return path.replace(/\.(md|markdown)$/i, '')
}

/**
 * The `content_links.target_key` strings that could be naming this document.
 *
 * The two spellings `resolveTargetKeys` registers for a row — the `type/slug`
 * an internal link is written as, and the path without its extension — plus the
 * bare slug on its own, which is how wiki links are usually written and which
 * the resolver reads as a candidate list rather than as a key.
 *
 * Both halves of each spelling are emitted because a directory-qualified link
 * and a bare one are different strings in the column, and an index can only be
 * asked for strings.
 */
export function incomingKeys(row: Pick<ContentRow, 'type' | 'slug' | 'path'>): string[] {
  const dir = CONTENT_TYPE_DIRS[row.type]
  const stem = pathStem(row.path)
  const tails = new Set([
    row.slug,
    stem.startsWith(`${dir}/`) ? stem.slice(dir.length + 1) : stem,
  ])

  const keys = new Set<string>()
  for (const tail of tails) {
    keys.add(`${dir}/${tail}`)
    keys.add(tail)
  }
  return [...keys]
}

/**
 * Map `posts/foo` keys to the documents they name, in a single query.
 *
 * A key resolves against **two** names for the same document, because the two
 * are both natural to write and they are not the same string. A document's slug
 * is derived from its title (see `deriveContent`), while its filename is what
 * the author sees in the directory listing. For a note titled "An empty catch
 * block is a claim that nothing can go wrong" the slug is the whole sentence and
 * the filename is `why-not-catch`.
 *
 * Matching only the slug means `[[why-not-catch]]` — the obvious link to write —
 * resolves to nothing and renders as plain text, with no error and no backlink.
 * Matching only the filename would break every link that used the slug. Both
 * keys are registered instead, so either spelling works and neither silently
 * wins.
 *
 * A key that names nothing is simply absent from the result; deciding what to do
 * about that belongs to the caller, which knows whether it is writing an edge or
 * a page.
 */
export async function resolveTargetKeys(
  keys: readonly string[],
): Promise<Map<string, ResolvedTarget>> {
  const result = new Map<string, ResolvedTarget>()
  if (keys.length === 0) return result

  const byType = new Map<ContentType, Array<{ name: string; path: string }>>()
  for (const key of keys) {
    const parsed = parseInternalTarget(`/${key}`)
    if (!parsed) continue
    const dir = CONTENT_TYPE_DIRS[parsed.type]
    const list = byType.get(parsed.type) ?? []
    for (const ext of MARKDOWN_EXTENSIONS) {
      list.push({ name: parsed.slug, path: `${dir}/${parsed.slug}${ext}` })
    }
    byType.set(parsed.type, list)
  }

  for (const [type, entries] of byType) {
    const slugs = entries.map((entry) => entry.name)
    const paths = entries.map((entry) => entry.path)

    const rows = await db
      .select({ id: contentIndex.id, slug: contentIndex.slug, path: contentIndex.path })
      .from(contentIndex)
      .where(
        and(
          eq(contentIndex.type, type),
          or(inArray(contentIndex.slug, slugs), inArray(contentIndex.path, paths)),
        ),
      )

    const prefix = CONTENT_TYPE_DIRS[type]
    for (const row of rows) {
      const target: ResolvedTarget = {
        id: row.id,
        type,
        slug: row.slug,
        url: documentUrl(type, row.slug),
      }
      result.set(`${prefix}/${row.slug}`, target)
      // The filename key — how a wiki link names it. The same helper builds the
      // keys `resolveIncomingLinks` searches for, so the two agree by
      // construction rather than by review.
      result.set(pathStem(row.path), target)
    }
  }

  return result
}

/**
 * Map each wiki target — as written — to the document it names.
 *
 * The renderer's entry point, and the reason a bare `[[slug]]` works on a page:
 * the candidates are all fetched in one query and the first that exists wins,
 * which is the same rule and the same function (`pickTarget`) the sync engine
 * applies to the same target.
 *
 * A target that names nothing is absent from the result, and the caller is
 * expected to leave it as the author wrote it.
 */
export async function resolveWikiTargets(
  targets: readonly string[],
): Promise<Map<string, ResolvedTarget>> {
  const wanted = new Set<string>()
  for (const target of targets) {
    for (const key of wikiTargetCandidates(target)) wanted.add(key)
  }

  const byKey = await resolveTargetKeys([...wanted])
  const result = new Map<string, ResolvedTarget>()
  if (byKey.size === 0) return result

  for (const target of targets) {
    const found = pickTarget({ kind: 'wiki', targetKey: target }, byKey)
    if (found) result.set(target, found)
  }

  return result
}
