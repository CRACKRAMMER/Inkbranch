import { z } from 'zod'

import { CONTENT_TYPES } from '@/lib/content/schema'
import {
  DEFAULT_GRAPH_LIMIT,
  MAX_GRAPH_LIMIT,
  getKnowledgeGraph,
} from '@/lib/graph/graph'

import { listParam } from '../_params'

/**
 * The knowledge graph, for the visualisation.
 *
 * `/graph` mounts, notices the payload is not in the bundle, and fetches it
 * here — which is what keeps a force-layout renderer and a graph of the whole
 * archive out of every other page on the site.
 *
 * The payload is exactly `KnowledgeGraph`: nodes carry `{ id, type, slug, title,
 * url, degree, tags }` and edges are index pairs into that array. Nothing that
 * could be looked up later is in it, and this handler adds nothing to it. That
 * is not route-fastidiousness: the graph is the one response on this site whose
 * design constraint is that it stays small enough to fetch on a page load, and a
 * convenience field added here is a convenience field sent to every reader.
 *
 * `type` is one of three content types or `'tag'`: the response is the documents
 * the filters admitted and the tags those documents carry. `total` counts the
 * first and `tagTotal` the second, because they are capped separately and one
 * figure for both would be wrong about whichever it did not count.
 *
 * ## The parameters
 *
 * `types`, `minDegree`, `limit` and `tags` are the widening controls the module
 * already exposes, and they are validated rather than clamped: the only caller
 * is this site's own page, so a `limit` outside the range is a bug in that page
 * rather than a reader's typo, and a 400 is what surfaces it. An unusable `type`
 * is answered the same way, because silently returning all three types would
 * make a misspelled filter look like a filter that matched everything.
 *
 * `minDegree` defaults to **0** here, deliberately overriding the module's own
 * default of 1. The page fetches once and narrows the view in the browser, so a
 * server-side degree filter would remove nodes that no client-side control
 * could bring back. `limit` still bounds the response, so the default view is
 * the whole corpus up to 250 nodes rather than an unbounded one.
 *
 * `tags` is a boolean spelled `0`/`1`, and the only parameter that is not a
 * narrowing of the same kind: it decides whether the tag half of the graph is
 * drawn at all. It defaults to on, so `?tags=0` is the way to ask for the
 * document graph as it was before tags were nodes in it.
 */

/**
 * A node cannot have more neighbours than there are nodes, so the ceiling on
 * the response is also the ceiling on a sensible degree filter. A larger value
 * is not dangerous — it simply selects nothing — but "selects nothing" is the
 * kind of answer a bound is there to refuse in favour of a clear one.
 */
const MAX_MIN_DEGREE = MAX_GRAPH_LIMIT

const querySchema = z.object({
  // Repeated or comma-separated, both accepted — see `../_params`.
  types: z.array(z.enum(CONTENT_TYPES)).max(CONTENT_TYPES.length),
  limit: z.coerce.number().int().min(1).max(MAX_GRAPH_LIMIT).optional(),
  minDegree: z.coerce.number().int().min(0).max(MAX_MIN_DEGREE).optional(),
  // Not `z.coerce.boolean()`, which is `Boolean()`: it reads `?tags=0` as true
  // and would make the one value a caller would write to mean "off" mean "on".
  tags: z.enum(['0', '1', 'false', 'true']).optional(),
})

/**
 * Fresh enough that a published document appears while the author is still
 * looking at the page, cached enough that a shared cache answers the second
 * visitor. The response is public and identical for every reader, so it is safe
 * to hold at the edge; it changes when content changes, which is minutes apart
 * at worst.
 */
const CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams

  const parsed = querySchema.safeParse({
    types: listParam(params.getAll('types')),
    limit: params.get('limit') ?? undefined,
    minDegree: params.get('minDegree') ?? undefined,
    tags: params.get('tags') ?? undefined,
  })

  if (!parsed.success) {
    return Response.json(
      {
        error: 'Invalid graph query.',
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || 'query'}: ${issue.message}`,
        ),
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    )
  }

  // Absent means "whatever the module defaults to", which is on: the node project
  // asks the picture for includes tags, and a caller who does not mention the
  // parameter is asking for the picture.
  const includeTags =
    parsed.data.tags === undefined
      ? undefined
      : parsed.data.tags === '1' || parsed.data.tags === 'true'

  try {
    const graph = await getKnowledgeGraph({
      // An empty filter is not a filter: `?types=` means "all three", which is
      // what a client that cleared a multi-select is asking for.
      types: parsed.data.types.length > 0 ? parsed.data.types : undefined,
      minDegree: parsed.data.minDegree ?? 0,
      limit: parsed.data.limit ?? DEFAULT_GRAPH_LIMIT,
      includeTags,
    })

    return Response.json(graph, { headers: { 'cache-control': CACHE_CONTROL } })
  } catch (error) {
    // The index is built from `content_index` and `content_links`, so a failure
    // here is a database that is not answering. An empty node list would draw a
    // site with no connections, which is a different claim from "the graph
    // could not be built".
    console.error(
      '[graph] the graph could not be built:',
      error instanceof Error ? error.message : error,
    )
    return Response.json(
      { error: 'The graph is unavailable right now.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}
