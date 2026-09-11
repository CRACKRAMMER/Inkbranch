import 'server-only'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import {
  buildAdjacency,
  clampLimit,
  edgePairsOf,
  findOrphans,
  indexEdges,
  isVisible,
  selectGraphNodes,
  sortTagsByRarity,
  type GraphEdge,
  type GraphNode,
  type KnowledgeGraph,
  type OrphanNode,
} from './model'
import { getRelationsIndex, scoringContext } from './relations'

/**
 * The knowledge graph: nodes and edges for a lazily loaded visualisation.
 *
 * ## The payload is the feature
 *
 * Project.md requires the graph to stay out of the main bundle and to be fetched
 * only when `/graph` mounts. That makes the payload the thing to design around,
 * because a route that lazily fetches two megabytes has not really been kept out
 * of anything. So nodes carry `{ id, type, slug, title, url, degree, tags }` and
 * nothing else — no body, no description, no headings, no dates — and edges are
 * index pairs rather than ids. Everything that could be looked up later has been
 * left out on purpose.
 *
 * ## Why the default view is not everything
 *
 * Five thousand documents with two links each is a hairball; the picture stops
 * answering any question the moment it stops fitting on a screen. The default is
 * therefore a degree-limited view — connected documents only, best-connected
 * first, capped — and the parameters to widen it are `minDegree`, `limit` and
 * `types`. Documents that are not connected appear in `getOrphans()` instead,
 * which is the list an author can act on; drawing them as a cloud of dots is not.
 */

export interface GraphOptions {
  /** Maximum nodes returned. Defaults to `DEFAULT_GRAPH_LIMIT`. */
  limit?: number
  /** Restrict to these content types. Absent means all three. */
  types?: readonly ContentType[]
  /**
   * Minimum distinct neighbours. Defaults to `DEFAULT_MIN_DEGREE`.
   * `0` includes unconnected documents, `2` and up shows the core.
   */
  minDegree?: number
  /** Statuses a node may have. Defaults to published. */
  statuses?: readonly ContentStatus[]
}

/**
 * Enough nodes to see structure, few enough to draw and to parse quickly. A
 * force layout gets unreadable well before this, and the payload stays in the
 * tens of kilobytes.
 */
export const DEFAULT_GRAPH_LIMIT = 250
export const MAX_GRAPH_LIMIT = 2_000

/**
 * Connected documents only. A node with no edges carries no information a
 * picture can show; `getOrphans()` is where those belong.
 */
export const DEFAULT_MIN_DEGREE = 1

const DEFAULT_STATUSES: readonly ContentStatus[] = ['published']

/**
 * Nodes and edges for the visualisation.
 *
 * The type and status filters are applied once, here, and everything after them
 * describes the same set of documents — the adjacency, the degrees, the nodes
 * and the `total`. A degree counted against documents the caller asked to leave
 * out would be a node's degree in a graph nobody is being shown, and a node
 * whose only neighbour was filtered away would arrive as a dot with no edges.
 *
 * Edges are then taken from the retained nodes' outbound links, so they are
 * always consistent with the node list they ship with: an edge to a document the
 * limit dropped is removed rather than renumbered. A self-reference is not an
 * edge.
 */
export async function getKnowledgeGraph(
  options: GraphOptions = {},
): Promise<KnowledgeGraph> {
  const index = await getRelationsIndex()
  const statuses = new Set(options.statuses ?? DEFAULT_STATUSES)
  const types = options.types ? new Set(options.types) : null

  const visible = index.nodes.filter(
    (node) => isVisible(node, statuses) && (!types || types.has(node.type)),
  )

  const edges = edgePairsOf(visible)
  const adjacency = buildAdjacency(edges)

  const selected = selectGraphNodes(visible, adjacency, {
    limit: clampLimit(options.limit, DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT),
    minDegree: options.minDegree ?? DEFAULT_MIN_DEGREE,
  })

  const context = scoringContext(index)

  return {
    // The round trip through `sortTagsByRarity` is what a client colouring by
    // `tags[0]` colours by: the most distinctive tag the document carries, not
    // whichever one its frontmatter listed first.
    nodes: selected.map(
      (node): GraphNode => ({
        ...node,
        tags: sortTagsByRarity(node.tags, context),
      }),
    ),
    edges: indexEdges(selected, edges),
    total: visible.length,
    truncated: index.truncated,
  }
}

export interface OrphanOptions {
  types?: readonly ContentType[]
  statuses?: readonly ContentStatus[]
}

/**
 * Documents with no links in or out, newest first.
 *
 * The other half of the degree-limited default: the graph hides unconnected
 * documents, and this is the list that says which ones they are and how many
 * there are, so the decision to hide them is visible rather than silent.
 */
export async function getOrphans(
  options: OrphanOptions = {},
): Promise<OrphanNode[]> {
  const index = await getRelationsIndex()
  const statuses = new Set(options.statuses ?? DEFAULT_STATUSES)
  const types = options.types ? new Set(options.types) : null

  const visible = index.nodes.filter(
    (node) => isVisible(node, statuses) && (!types || types.has(node.type)),
  )

  return findOrphans(visible, buildAdjacency(edgePairsOf(visible)))
}

export type { GraphEdge, GraphNode, KnowledgeGraph, OrphanNode }
