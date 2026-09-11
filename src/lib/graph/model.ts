import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { tokenize } from '@/lib/search/tokenize'

/**
 * The relation model.
 *
 * Everything in this file is a pure function over plain data. The three public
 * entry points — `getBacklinks`, `getRelatedPosts`, `getKnowledgeGraph` — read
 * the database and hand the result to these functions. That split is deliberate:
 * ranking and selection are the parts with rules that can be wrong in ways a
 * page still renders, so they are the parts that have to be testable without a
 * database.
 *
 * ## What a node is allowed to hold
 *
 * `RelationNode` carries only what `content_index` and `content_links` can
 * supply. There is no body: the body is the Markdown file, and anything wanting
 * it has to read the file. Similarity is therefore computed from tags, links and
 * the prose that *is* indexed — headings and description.
 *
 * This file, unlike its three callers, does not import `server-only`: it touches
 * nothing but its arguments, so the graph payload and the ranking rules stay
 * usable from a client component.
 *
 *
 * ## Why links are undirected here
 *
 * A directed graph is the truth about the writing, but every question these
 * features ask is symmetric. "Related" means related in both directions: if B
 * links to A, A's page should list B. Degree is used to decide what is worth
 * drawing, and a document that is only ever linked *to* is exactly as connected
 * as one that only links out. `backlink` below is the one place direction would
 * matter, and it is symmetric there too, on purpose.
 */

/** One document, as much of it as the relation index holds. */
export interface RelationNode {
  id: string
  type: ContentType
  slug: string
  title: string
  url: string
  description: string
  status: ContentStatus
  series: string | null
  publishedAt: Date | null
  updatedAt: Date
  /** Heading text, in document order. */
  headings: string[]
  /** Tag slugs. `tags.slug` is unique, so a slug is the identity of a tag. */
  tags: string[]
  /** Ids of the documents this one links to. Resolved links only, deduped. */
  outgoing: string[]
  /** Ids of the documents that link here. Resolved links only, deduped. */
  incoming: string[]
}

/** A resolved reference between two documents. */
export interface EdgePair {
  source: string
  target: string
}

/** Fields every tie-break needs. Narrower than `RelationNode` so tests and
 * callers that hold a summary row can still sort with the same rule. */
export interface SortableNode {
  id: string
  slug: string
  publishedAt: Date | null
  updatedAt: Date
}

/* -------------------------------------------------------------------------- */
/*  Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether a document is public enough to appear on a page.
 *
 * A scheduled document becomes visible the moment its time arrives, without
 * waiting for a job to rewrite the row — the same rule the search provider
 * applies, and it has to stay the same rule, or a page will link to a draft the
 * search box refuses to find.
 */
export function isVisible(
  node: Pick<RelationNode, 'status' | 'publishedAt'>,
  statuses: ReadonlySet<ContentStatus>,
): boolean {
  if (statuses.has(node.status)) return true
  return (
    statuses.has('published') &&
    node.status === 'scheduled' &&
    node.publishedAt !== null &&
    node.publishedAt.getTime() <= Date.now()
  )
}

/* -------------------------------------------------------------------------- */
/*  Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Clamp a caller-supplied limit into `[1, max]`, falling back when absent. */
export function clampLimit(
  limit: number | undefined,
  fallback: number,
  max: number,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.min(max, Math.max(1, Math.floor(limit)))
}

/* -------------------------------------------------------------------------- */
/*  Rarity                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A tag on almost every document still carries a little signal, and a weight of
 * zero would make it indistinguishable from not being there at all.
 */
const TAG_WEIGHT_FLOOR = 0.05

/**
 * How much one tag is worth, by how rare it is.
 *
 * The BM25 IDF the search module already uses, for the same reason it uses it:
 * sharing `postgres-internals` should say far more than sharing `javascript`,
 * and no fixed table of tag importances can know which is which on a corpus the
 * author is still writing. At 100 documents this gives a tag on one document
 * ~4.2 and a tag on ninety of them the floor, so a rare shared tag outweighs a
 * common one by roughly two orders of magnitude.
 */
export function tagWeight(
  documentCount: number,
  tagDocumentCount: number,
): number {
  if (documentCount <= 0) return 0
  // A tag with no documents is not in the index. Clamping the count instead of
  // letting `df = 0` through keeps a missing lookup from scoring higher than a
  // tag that really is unique to one document.
  const df = Math.min(Math.max(tagDocumentCount, 1), documentCount)
  return Math.max(
    TAG_WEIGHT_FLOOR,
    Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)),
  )
}

/** The rarity inputs every scoring call needs. Built once per index, not per pair. */
export interface RelatedContext {
  /** Documents in the index, including drafts. */
  documentCount: number
  /** Tag slug → number of documents carrying it. */
  tagDocumentCount: ReadonlyMap<string, number>
}

function weightOf(context: RelatedContext): (tag: string) => number {
  return (tag) => tagWeight(context.documentCount, context.tagDocumentCount.get(tag) ?? 1)
}

/* -------------------------------------------------------------------------- */
/*  Signals                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Weighted Jaccard over two tag sets, in `[0, 1]`.
 *
 * Weighted on both sides, so the ratio is dominated by the tags the two
 * documents share rather than by the size of either list: a document with forty
 * tags cannot outrank one with three by having more to intersect, and adding an
 * unrelated tag can only lower the score.
 */
export function tagAffinity(
  a: readonly string[],
  b: readonly string[],
  context: RelatedContext,
): number {
  if (a.length === 0 || b.length === 0) return 0

  const weight = weightOf(context)
  const left = new Set(a)
  const right = new Set(b)
  let shared = 0
  let union = 0

  for (const tag of left) {
    const value = weight(tag)
    union += value
    if (right.has(tag)) shared += value
  }
  for (const tag of right) {
    if (!left.has(tag)) union += weight(tag)
  }

  return union > 0 ? shared / union : 0
}

/**
 * Jaccard over two sets of linked documents, in `[0, 1]`.
 *
 * Unweighted, unlike tags. The tag weighting exists because some tags are on
 * everything; the equivalent for links would weight a reference by how many
 * other documents point at the same target, which is a second pass over the
 * link table to answer a question nobody has asked. Two documents citing each
 * other's sources is a strong enough signal as it is.
 */
export function linkAffinity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0

  const inB = new Set(b)
  let shared = 0
  for (const id of new Set(a)) if (inB.has(id)) shared += 1

  const union = new Set([...a, ...b]).size
  return union > 0 ? shared / union : 0
}

/** Whether either document links to the other. */
export function linksDirectly(a: RelationNode, b: RelationNode): boolean {
  return a.outgoing.includes(b.id) || b.outgoing.includes(a.id)
}

/** The fields `termOverlap` reads. Narrow so a test can pass two literals. */
export interface ProseFields {
  description: string
  headings: readonly string[]
}

/**
 * Jaccard over the prose the index actually holds: headings and description.
 *
 * Not the body. The body is on disk, and comparing two bodies means reading
 * both files for every candidate on every render — the cost this module exists
 * to avoid. Headings and description are in `content_index`, so a document whose
 * sections are about the same things as this one can be recognised without
 * touching the filesystem. What is missed is the case where two articles share
 * no vocabulary in their headings but argue about the same thing at length; that
 * is a body-text similarity, and it is not on offer here.
 *
 * Terms are stems, the same reduction search indexes under, so `indexing` and
 * `index` are one term rather than two misses.
 */
export function termOverlap(a: ProseFields, b: ProseFields): number {
  const left = proseTerms(a)
  const right = proseTerms(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1

  const union = new Set([...left, ...right]).size
  return union > 0 ? shared / union : 0
}

function proseTerms(fields: ProseFields): Set<string> {
  const terms = new Set<string>()
  for (const text of [fields.description, ...fields.headings]) {
    for (const token of tokenize(text)) terms.add(token.stem)
  }
  return terms
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

export interface RelatedSignals {
  /** Shared tags, rarity-weighted. */
  tags: number
  /** Documents both link to. */
  links: number
  /** One links to the other. */
  backlink: number
  /** Same series. */
  series: number
  /** Shared vocabulary in headings and description. */
  terms: number
}

/**
 * The signal weights, summing to 1.
 *
 * Summing to one is what makes the score bounded without normalising against the
 * corpus afterwards: every signal is already in `[0, 1]`, so the total is too,
 * and `1` is exactly "identical tags, all the same sources, in the same series,
 * about the same thing". A document cannot be more related to something than to
 * its own duplicate, which is a property worth being able to state.
 *
 * Tuned by reading results on this corpus, like the field weights in the search
 * module, rather than fitted to a labelled set — there are no labels.
 */
export const SIGNAL_WEIGHTS: Record<keyof RelatedSignals, number> = {
  // Highest by a distance: on a personal corpus tags are assigned deliberately,
  // while links are also made casually and series membership is a coarse fact.
  tags: 0.4,
  links: 0.25,
  // A direct reference is one relationship, however the two documents otherwise
  // compare, so it is worth a fixed amount rather than a computed one.
  backlink: 0.15,
  series: 0.1,
  terms: 0.1,
}

export interface RelatedScore {
  /** In `[0, 1]`. See `SIGNAL_WEIGHTS`. */
  total: number
  signals: RelatedSignals
}

/** Score one candidate against the subject. Pure; the caller supplies rarity. */
export function scoreRelated(
  subject: RelationNode,
  candidate: RelationNode,
  context: RelatedContext,
): RelatedScore {
  const signals: RelatedSignals = {
    tags: tagAffinity(subject.tags, candidate.tags, context),
    links: linkAffinity(subject.outgoing, candidate.outgoing),
    backlink: linksDirectly(subject, candidate) ? 1 : 0,
    series: sameSeries(subject, candidate) ? 1 : 0,
    terms: termOverlap(subject, candidate),
  }

  let total = 0
  for (const signal of Object.keys(SIGNAL_WEIGHTS) as (keyof RelatedSignals)[]) {
    total += SIGNAL_WEIGHTS[signal] * signals[signal]
  }

  return { total, signals }
}

function sameSeries(a: RelationNode, b: RelationNode): boolean {
  return a.series !== null && a.series === b.series
}

/* -------------------------------------------------------------------------- */
/*  Ordering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Newest first, then slug, then id.
 *
 * Every list this module returns ends with this comparison, so nothing here can
 * reshuffle between two requests that read the same data. A related list whose
 * order changes on reload looks broken even when every entry in it is correct,
 * and `Map` iteration order and `Array.prototype.sort` stability are not
 * promises a page can be built on.
 *
 * `publishedAt` falls back to `updatedAt` for a document that has never been
 * published, matching how the search provider breaks its ties. Null sorts oldest.
 */
export function compareStable(a: SortableNode, b: SortableNode): number {
  const at = (a.publishedAt ?? a.updatedAt).getTime()
  const bt = (b.publishedAt ?? b.updatedAt).getTime()
  if (at !== bt) return bt - at

  const bySlug = a.slug.localeCompare(b.slug)
  if (bySlug !== 0) return bySlug

  // Slugs are unique per type, not across types, so the id is what makes the
  // order total. Without it two documents could compare equal and `sort` would
  // keep whichever the input happened to list first.
  return a.id.localeCompare(b.id)
}

/** A node with its score, as returned by `rankRelated`. */
export interface RankedNode {
  node: RelationNode
  score: RelatedScore
}

/**
 * Score every candidate and return them best first.
 *
 * Candidates with no signal at all are dropped rather than returned at the
 * bottom of the list: "nothing in common" is not a weak relation, it is the
 * absence of one, and a page that pads its related list with unrelated
 * documents teaches the reader to ignore the list.
 */
export function rankRelated(
  subject: RelationNode,
  candidates: readonly RelationNode[],
  context: RelatedContext,
): RankedNode[] {
  const ranked: RankedNode[] = []

  for (const candidate of candidates) {
    if (candidate.id === subject.id) continue

    const score = scoreRelated(subject, candidate, context)
    if (score.total <= 0) continue

    ranked.push({ node: candidate, score })
  }

  ranked.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    return compareStable(a.node, b.node)
  })

  return ranked
}

/**
 * A node's tags, most distinctive first.
 *
 * A client colouring nodes by `tags[0]` then colours by what a document is
 * actually about, instead of by whichever tag happened to be first in its
 * frontmatter. Ties — two tags carried by the same number of documents — fall
 * back to the slug, so the order does not depend on the map's iteration order.
 */
export function sortTagsByRarity(
  tags: readonly string[],
  context: RelatedContext,
): string[] {
  const weight = weightOf(context)
  return [...tags].sort((a, b) => {
    const diff = weight(b) - weight(a)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
}

/* -------------------------------------------------------------------------- */
/*  Graph selection                                                            */
/* -------------------------------------------------------------------------- */

/** A node in the serialised graph. Small on purpose: it is sent to the browser. */
export interface GraphNode {
  id: string
  type: ContentType
  slug: string
  title: string
  url: string
  /** Distinct neighbours, in either direction. */
  degree: number
  tags: string[]
}

/**
 * An edge, as indices into the `nodes` array it ships with.
 *
 * Two numbers rather than two uuids. At a thousand edges the difference is a few
 * kilobytes against a few hundred, and the graph is the one payload on this site
 * whose whole design constraint is that it must stay small. The client walks
 * `edges` to seed a force layout and `nodes` to look up titles, so an index is
 * as usable as an id here — but it is only meaningful alongside the exact array
 * it was built from, which is why `indexEdges` is always called with the nodes
 * being returned and never earlier.
 */
export interface GraphEdge {
  source: number
  target: number
}

/** The payload `/api/graph` returns. */
export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /**
   * Documents the filters admitted, before `limit` cut the list down. Lets a
   * caller say "showing 250 of 1840" rather than implying the corpus is small.
   */
  total: number
  /** True when a query bound was hit, so this is not the whole corpus. */
  truncated: boolean
}

/** Every undirected edge implied by the documents' outgoing links. */
export function edgePairsOf(
  nodes: readonly Pick<RelationNode, 'id' | 'outgoing'>[],
): EdgePair[] {
  const seen = new Set<string>()
  const pairs: EdgePair[] = []

  for (const node of nodes) {
    for (const target of node.outgoing) {
      // A document that links to itself is a footnote at most, and a self-loop
      // in a force layout is a bug that looks like a rendering artefact.
      if (target === node.id) continue

      // Undirected: whichever of A→B and B→A appears in the data, there is one
      // relationship, and two edges between the same pair would double both
      // nodes' degree and drag the layout apart.
      const key =
        node.id < target ? `${node.id}:${target}` : `${target}:${node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ source: node.id, target })
    }
  }

  return pairs
}

/**
 * The neighbourhood map: document id → ids it is connected to.
 *
 * This is the adjacency the rest of the graph work is defined over, and it is a
 * plain `Map` of `Set`s so that orphan detection and degree counting can be
 * tested against a literal rather than a database.
 */
export function buildAdjacency(
  edges: readonly EdgePair[],
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()

  for (const edge of edges) {
    neighboursOf(adjacency, edge.source).add(edge.target)
    neighboursOf(adjacency, edge.target).add(edge.source)
  }

  return adjacency
}

function neighboursOf(
  adjacency: Map<string, Set<string>>,
  id: string,
): Set<string> {
  const existing = adjacency.get(id)
  if (existing) return existing
  const created = new Set<string>()
  adjacency.set(id, created)
  return created
}

/** Distinct neighbours, either direction. A node absent from the map has none. */
export function degreeOf(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  id: string,
): number {
  return adjacency.get(id)?.size ?? 0
}

export interface GraphSelectionOptions {
  limit: number
  /**
   * Minimum distinct neighbours. `1` is the default view — connected documents
   * only; `0` includes everything and is a hairball, `2` or more shows the core.
   */
  minDegree: number
}

/**
 * The nodes worth drawing, best-connected first.
 *
 * Selection rather than truncation: taking the first `limit` documents would
 * show whichever ones sorted first and call it the graph. Degree is the only
 * ordering that makes a partial graph useful — the hub documents and their
 * neighbours are what the picture is for — and ties fall through to
 * `compareStable`, so the same corpus always yields the same view.
 *
 * Type and status filtering is the caller's, so that the nodes, the edges and
 * the `total` a caller reports all describe the same set. Here the only
 * questions are how connected a document is and how many are wanted.
 */
export function selectGraphNodes(
  nodes: readonly RelationNode[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  options: GraphSelectionOptions,
): GraphNode[] {
  const eligible = nodes.filter(
    (node) => degreeOf(adjacency, node.id) >= options.minDegree,
  )

  eligible.sort((a, b) => {
    const diff = degreeOf(adjacency, b.id) - degreeOf(adjacency, a.id)
    return diff !== 0 ? diff : compareStable(a, b)
  })

  return eligible.slice(0, options.limit).map((node) => ({
    id: node.id,
    type: node.type,
    slug: node.slug,
    title: node.title,
    url: node.url,
    degree: degreeOf(adjacency, node.id),
    tags: [...node.tags],
  }))
}

/**
 * Re-index the edges of a node selection, dropping the ones that reach outside it.
 *
 * An edge pointing at a node the limit removed would be an index into the wrong
 * document once the client walks the array, so the pruning is not tidying — it
 * is the only thing keeping the payload internally consistent.
 */
export function indexEdges(
  nodes: readonly { id: string }[],
  edges: readonly EdgePair[],
): GraphEdge[] {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]))
  const result: GraphEdge[] = []

  for (const edge of edges) {
    const source = indexById.get(edge.source)
    const target = indexById.get(edge.target)
    if (source === undefined || target === undefined) continue
    result.push({ source, target })
  }

  return result
}

/** A document with no connections at all. */
export interface OrphanNode {
  id: string
  type: ContentType
  slug: string
  title: string
  url: string
  publishedAt: Date | null
}

/**
 * Documents with no links in or out.
 *
 * Tags are deliberately not counted. Almost every document has one, so treating
 * a shared tag as a connection would report an orphan list that is empty on a
 * site that plainly has unconnected writing in it. The list is meant to be the
 * work queue for a digital garden: what has been published and then left
 * floating, newest first.
 */
export function findOrphans(
  nodes: readonly RelationNode[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): OrphanNode[] {
  const orphans = nodes
    .filter((node) => degreeOf(adjacency, node.id) === 0)
    .sort(compareStable)

  return orphans.map((node) => ({
    id: node.id,
    type: node.type,
    slug: node.slug,
    title: node.title,
    url: node.url,
    publishedAt: node.publishedAt,
  }))
}
