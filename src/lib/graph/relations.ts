import 'server-only'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { env } from '@/env'
import { documentUrl } from '@/lib/content/paths'
import { db } from '@/lib/db'
import {
  contentIndex,
  contentLinks,
  contentTags,
  tags as tagsTable,
} from '@/lib/db/schema'
import type { RelatedContext, RelationNode } from './model'

/**
 * The relation index.
 *
 * One in-memory copy of everything the link table and the content index say
 * about how documents relate, built once and shared by backlinks, related posts
 * and the knowledge graph. It is a cache with a short time-to-live, not a
 * source of truth: the database is still the authority, and dropping the cache
 * costs one rebuild.
 *
 * ## Why it exists
 *
 * Related posts needs a document frequency per tag — how many documents carry
 * `postgres-internals` out of how many documents there are. That is a fact about
 * the whole corpus, so computing it per request means reading the whole corpus
 * per request, and an article page that does that is a page that gets slower
 * with every post the author writes. Building it once behind a fingerprint makes
 * the cost proportional to *changes* rather than to traffic.
 *
 * ## Shape of the reads
 *
 * Three queries, always three, whatever the corpus size: the documents, the
 * resolved links, the tag assignments. Joining them happens in memory, because
 * the alternative — a query per document — is the N+1 that makes this kind of
 * feature fall over at exactly the size where it starts being useful.
 *
 * Every query is bounded, and the bounds are derived from `CONTENT_MAX_FILES`:
 * the scanner will not index more documents than that, so a table larger than
 * the bound means something wrote to it outside the sync engine. When a bound is
 * hit the index records it rather than pretending the corpus is complete.
 */

export interface RelationsIndex {
  nodes: RelationNode[]
  byId: Map<string, RelationNode>
  /** Documents in the index. Denominator of every rarity weight. */
  documentCount: number
  /** Tag slug → number of documents carrying it. The rarity input. */
  tagDocumentCount: Map<string, number>
  /**
   * Tag slug → the name to show for it.
   *
   * A second map over the same slugs rather than a map of records, because the
   * count is a scoring input with its own type — it flows into `RelatedContext`
   * as `ReadonlyMap<string, number>` — and reshaping a scoring input to carry a
   * display string would put a presentation concern inside the ranking code. The
   * two are built in one loop over one query, so they cannot drift.
   */
  tagNames: Map<string, string>
  /** True when a query bound was hit and this is only part of the corpus. */
  truncated: boolean
  builtAt: number
}

/**
 * Row ceilings. A document with more than 32 distinct resolved references, or
 * more than 16 tags, is outside anything this site's frontmatter can express, so
 * the ceiling only ever fires on data that got into the tables some other way.
 */
const MAX_LINK_ROWS = env.CONTENT_MAX_FILES * 32
const MAX_TAG_ROWS = env.CONTENT_MAX_FILES * 16

/** How long a built index is trusted before the fingerprint is read again. */
const FINGERPRINT_TTL_MS = 5_000

/* -------------------------------------------------------------------------- */
/*  Cache                                                                      */
/* -------------------------------------------------------------------------- */

let cachedIndex: RelationsIndex | null = null
let cachedFingerprint: string | null = null
let fingerprintCheckedAt = 0
let building: Promise<RelationsIndex> | null = null

/**
 * A cheap signature of everything the index is derived from.
 *
 * `updatedAt` moving catches an edit; `insertedAt` catches a document that has
 * just appeared, which is also how a previously broken wiki link starts
 * resolving; the document count catches a deletion; and the byte total catches
 * an edit that left `updatedAt` alone, which happens whenever the author sets
 * the frontmatter `updated` field to a date in the past — a common enough habit
 * that relying on the timestamps alone would mean serving a stale index until
 * the process restarted.
 *
 * One aggregate, and it reads a table bounded by `CONTENT_MAX_FILES`. Running it
 * once per TTL window is the whole cost of keeping the index honest.
 */
async function relationsFingerprint(): Promise<string> {
  const [row] = await db
    .select({
      documents: sql<number>`count(*)::int`,
      newestUpdate: sql<string | null>`extract(epoch from max(${contentIndex.updatedAt}))::text`,
      newestInsert: sql<string | null>`extract(epoch from max(${contentIndex.insertedAt}))::text`,
      totalBytes: sql<string | null>`sum(${contentIndex.byteSize})::text`,
    })
    .from(contentIndex)

  return [
    row?.documents ?? 0,
    row?.newestUpdate ?? '',
    row?.newestInsert ?? '',
    row?.totalBytes ?? '',
  ].join(':')
}

/**
 * The current index, rebuilt when the data behind it has moved.
 *
 * Concurrent callers share one build through the in-flight promise. An article
 * page asks for backlinks, related posts and a graph payload in the same render;
 * without this they would race each other into three builds of the same index.
 */
export async function getRelationsIndex(): Promise<RelationsIndex> {
  const now = Date.now()

  if (
    cachedIndex &&
    cachedFingerprint !== null &&
    now - fingerprintCheckedAt < FINGERPRINT_TTL_MS
  ) {
    return cachedIndex
  }

  const fingerprint = await relationsFingerprint()
  fingerprintCheckedAt = now

  if (cachedIndex && fingerprint === cachedFingerprint) return cachedIndex

  building ??= buildRelationsIndex()
    .then((index) => {
      cachedIndex = index
      cachedFingerprint = fingerprint
      return index
    })
    .finally(() => {
      building = null
    })

  return building
}

/** Drop the cached index. Used by the sync engine, the CLI and tests. */
export function invalidateRelationsIndex(): void {
  cachedIndex = null
  cachedFingerprint = null
  fingerprintCheckedAt = 0
}

/** The rarity inputs, read off a built index. */
export function scoringContext(index: RelationsIndex): RelatedContext {
  return {
    documentCount: index.documentCount,
    tagDocumentCount: index.tagDocumentCount,
  }
}

/* -------------------------------------------------------------------------- */
/*  Building                                                                   */
/* -------------------------------------------------------------------------- */

async function buildRelationsIndex(): Promise<RelationsIndex> {
  const [documents, links, taggings] = await Promise.all([
    // Ordered, so that hitting the ceiling drops a stable set of rows rather
    // than whatever the planner happened to return that day.
    db
      .select({
        id: contentIndex.id,
        type: contentIndex.type,
        slug: contentIndex.slug,
        title: contentIndex.title,
        description: contentIndex.description,
        status: contentIndex.status,
        series: contentIndex.series,
        publishedAt: contentIndex.publishedAt,
        updatedAt: contentIndex.updatedAt,
        headings: contentIndex.headings,
      })
      .from(contentIndex)
      .orderBy(contentIndex.id)
      .limit(env.CONTENT_MAX_FILES),

    // `target_id is not null` is the filter, not `resolved`. The two agree for
    // the kinds that have a target to find, but `resolved` is `true` for the
    // kinds that have none — an image reference or an anchor — so filtering on
    // it would offer this pass an edge to a null end. The target being non-null
    // is what "links to a document" actually means.
    db
      .select({
        sourceId: contentLinks.sourceId,
        targetId: contentLinks.targetId,
      })
      .from(contentLinks)
      .where(isNotNull(contentLinks.targetId))
      .orderBy(contentLinks.sourceId, contentLinks.targetId)
      .limit(MAX_LINK_ROWS),

    db
      .select({
        contentId: contentTags.contentId,
        slug: tagsTable.slug,
        // Only for labelling a tag node in the graph. A tag is written in
        // frontmatter as "Postgres Internals" and stored under a slug derived
        // from it, and the graph is a reading surface like the tag page — which
        // shows the name — so it has to show the name too.
        name: tagsTable.name,
      })
      .from(contentTags)
      .innerJoin(tagsTable, eq(tagsTable.id, contentTags.tagId))
      .orderBy(contentTags.contentId, tagsTable.slug)
      .limit(MAX_TAG_ROWS),
  ])

  const nodes: RelationNode[] = documents.map((row) => ({
    id: row.id,
    type: row.type,
    slug: row.slug,
    title: row.title,
    url: documentUrl(row.type, row.slug),
    description: row.description ?? '',
    status: row.status,
    series: row.series,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    headings: row.headings.map((heading) => heading.text),
    tags: [],
    outgoing: [],
    incoming: [],
  }))

  const byId = new Map(nodes.map((node) => [node.id, node]))

  // Deduplicated per node: one document can reach another two ways, with
  // `/posts/hello` and `[[hello]]`, and the link table stores those as separate
  // rows because they resolve by different rules. The relation between the two
  // documents is still one relation.
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()

  for (const link of links) {
    const target = link.targetId
    // A row can outlive its target: `on delete set null` keeps the row and
    // clears the column, and the null is filtered out in SQL. A row can also
    // name a source the document bound dropped, which is why both ends are
    // checked against the index rather than assumed to be in it.
    if (target === null || !byId.has(target)) continue
    if (!byId.has(link.sourceId)) continue

    setOf(outgoing, link.sourceId).add(target)
    setOf(incoming, target).add(link.sourceId)
  }

  for (const node of nodes) {
    node.outgoing = [...(outgoing.get(node.id) ?? [])]
    node.incoming = [...(incoming.get(node.id) ?? [])]
  }

  const tagDocumentCount = new Map<string, number>()
  const tagNames = new Map<string, string>()
  for (const tagging of taggings) {
    // Tag rows for documents the bound dropped would skew every rarity weight
    // towards rarity, which is the direction that quietly changes rankings.
    const node = byId.get(tagging.contentId)
    if (!node) continue

    node.tags.push(tagging.slug)
    tagDocumentCount.set(
      tagging.slug,
      (tagDocumentCount.get(tagging.slug) ?? 0) + 1,
    )
    tagNames.set(tagging.slug, tagging.name)
  }

  return {
    nodes,
    byId,
    documentCount: nodes.length,
    tagDocumentCount,
    tagNames,
    truncated:
      documents.length >= env.CONTENT_MAX_FILES ||
      links.length >= MAX_LINK_ROWS ||
      taggings.length >= MAX_TAG_ROWS,
    builtAt: Date.now(),
  }
}

function setOf(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key)
  if (existing) return existing
  const created = new Set<string>()
  map.set(key, created)
  return created
}
