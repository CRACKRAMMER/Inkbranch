import 'server-only'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import {
  clampLimit,
  isVisible,
  rankRelated,
  type RelatedSignals,
  type RelationNode,
} from './model'
import { getRelationsIndex, scoringContext } from './relations'

/**
 * Related posts: the local, non-AI algorithm.
 *
 * Project.md asks for related content computed from tags, category, internal
 * links and keywords, with no model in the loop. The signals used are the ones
 * this index can answer for itself — see `SIGNAL_WEIGHTS` in `./model` for the
 * weights and for why each exists.
 *
 * Category and series share the small membership weight. Keywords are the
 * heading and description overlap, which is as close to
 * "keywords" as an index without the body gets; see `termOverlap`.
 *
 * Everything runs against the in-memory relation index, so a page render costs
 * one array walk rather than a query per candidate, and the tag rarities it
 * needs are computed once per index rather than once per document. That caching
 * is the difference between this being a page feature and being a performance
 * trap — see `./relations`.
 */

/**
 * The name a caller of this feature invalidates. The cache it drops is shared
 * with the knowledge graph, so it is defined under its own name in
 * `./relations` and re-exported here under the one this API publishes.
 */
export { invalidateRelationsIndex as invalidateRelatedIndex } from './relations'

export interface RelatedPost {
  id: string
  type: ContentType
  slug: string
  title: string
  url: string
  description: string
  tags: string[]
  series: string | null
  publishedAt: Date | null
  /** In `[0, 1]`. Comparable between results of one call, and not across corpora. */
  score: number
  /**
   * What the score is made of, each signal in `[0, 1]` before weighting. Lets a
   * page explain a result ("shares postgres-internals") instead of asserting it,
   * the way search reports the fields a query matched.
   */
  signals: RelatedSignals
  /** A relationship shared with the subject, rather than a candidate label. */
  reason: string
}

export interface RelatedOptions {
  limit?: number
  /** Statuses a candidate may have. Defaults to published. */
  statuses?: readonly ContentStatus[]
}

/** Fits a sidebar or the foot of an article without pushing the next one away. */
export const DEFAULT_RELATED_LIMIT = 5
/** Even an explicit `limit: 500` gets this: the list is a list, not a page. */
export const MAX_RELATED_LIMIT = 20

const DEFAULT_STATUSES: readonly ContentStatus[] = ['published']

/**
 * The documents most related to `contentId`, best first.
 *
 * Empty when the document is not in the index — a page rendered for a document
 * that has just been deleted, or a row that never existed — because a related
 * list is an enhancement and not a reason to fail a render.
 */
export async function getRelatedPosts(
  contentId: string,
  options: RelatedOptions = {},
): Promise<RelatedPost[]> {
  const index = await getRelationsIndex()
  const subject = index.byId.get(contentId)
  if (!subject) return []

  const statuses = new Set(options.statuses ?? DEFAULT_STATUSES)
  const candidates = index.nodes.filter((node) => isVisible(node, statuses))

  const ranked = rankRelated(subject, candidates, scoringContext(index))
  const limit = clampLimit(options.limit, DEFAULT_RELATED_LIMIT, MAX_RELATED_LIMIT)

  return ranked.slice(0, limit).map((entry) => toRelatedPost(subject, entry.node, entry.score))
}

function toRelatedPost(
  subject: RelationNode,
  node: RelationNode,
  score: { total: number; signals: RelatedSignals },
): RelatedPost {
  const sharedTag = node.tags.find((tag) => subject.tags.includes(tag))
  const reason = score.signals.series && node.series ? node.series :
    sharedTag ? `#${sharedTag}` :
    score.signals.category && node.category ? node.category :
    score.signals.backlink ? 'linked document' :
    score.signals.links ? 'shared references' : 'similar topics'
  return {
    id: node.id,
    type: node.type,
    slug: node.slug,
    title: node.title,
    url: node.url,
    description: node.description,
    tags: node.tags,
    series: node.series,
    publishedAt: node.publishedAt,
    score: score.total,
    signals: score.signals,
    reason,
  }
}
