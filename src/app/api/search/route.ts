import { z } from 'zod'

import type { ContentType } from '@/lib/content/schema'
import { MAX_SEARCH_LIMIT, search } from '@/lib/search'

import { listParam } from '../_params'

/**
 * Search, over HTTP.
 *
 * The command palette and the search page both call this rather than importing
 * the provider, so switching `SEARCH_PROVIDER` to an external index later is a
 * server-side change with no client release attached to it.
 *
 * ## What this route will not do
 *
 * **It never forwards a status filter.** `SearchQuery.statuses` defaults to
 * published-only inside the provider and the route leaves it that way: an
 * endpoint that accepts `status=draft` is an endpoint anyone can use to
 * enumerate unfinished work, and the parameter would have to be checked on every
 * future edit. The cost is that a preview of an unpublished document cannot use
 * this route, which is correct — `/api/preview` exists for that and it is
 * authenticated.
 *
 * **It does not return bodies.** `SearchHit` carries a highlighted excerpt and
 * the fields the result needed to match; the body is not in it, and it is not
 * added here. A search endpoint that returns full text is a mirror of the
 * archive behind a query string.
 */

/** Bounds the tokeniser's work. A longer input is truncated, not refused. */
const MAX_QUERY_LENGTH = 200

/**
 * How far into a result set a caller may page. The provider ranks in memory, so
 * a large offset is not free — and nobody pages to result 5000 in a search box.
 */
const MAX_OFFSET = 1000

const querySchema = z.object({
  q: z
    .string()
    // Truncated rather than rejected: the cap exists to bound the work an
    // unbounded query string can ask for, not to tell a reader their search was
    // too long.
    .transform((value) => value.slice(0, MAX_QUERY_LENGTH)),
  types: z.array(z.enum(['post', 'note', 'project'])).max(3),
  tags: z.array(z.string().min(1).max(80)).max(10),
  // A category is a string rather than a row, so there is no slug to validate
  // against and no length it could not legitimately exceed. The cap is on how
  // many filters one request may carry, not on what a category may be called.
  categories: z.array(z.string().min(1).max(80)).max(10),
  // A limit that is absent or not a number carries no instruction, so it is
  // answered with the provider's own default. The ceiling below is a property
  // of the index, and a caller cannot raise it by asking.
  limit: z.coerce.number().int().catch(Number.NaN),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).catch(0),
})

/** The requested page size, clamped to what the index will answer. */
function pageSize(limit: number): number | undefined {
  if (!Number.isFinite(limit)) return undefined
  return Math.min(Math.max(Math.floor(limit), 1), MAX_SEARCH_LIMIT)
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams

  const parsed = querySchema.safeParse({
    q: params.get('q') ?? '',
    types: listParam(params.getAll('type')),
    tags: listParam(params.getAll('tag')),
    categories: listParam(params.getAll('category')),
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  })

  if (!parsed.success) {
    // Reached only by a filter that is not a content type or a tag that is
    // longer than any tag can be. The caller's own input is named back to it;
    // nothing else about this server is.
    return Response.json(
      {
        error: 'Invalid search query.',
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || 'query'}: ${issue.message}`,
        ),
      },
      { status: 400 },
    )
  }

  try {
    const result = await search({
      q: parsed.data.q,
      types: parsed.data.types as ContentType[],
      tags: parsed.data.tags,
      categories: parsed.data.categories,
      limit: pageSize(parsed.data.limit),
      offset: parsed.data.offset,
    })

    return Response.json(result, {
      // Search is interactive and the index is in this process. A shared cache
      // keyed by every query string anyone can type is a liability, not a win.
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    // The provider builds its index lazily from the content tree, so a failure
    // here is a real one — a disk or database that is not answering. An empty
    // result list would say "nothing matches", which is a different sentence.
    console.error(
      '[search] query could not be answered:',
      error instanceof Error ? error.message : error,
    )
    return Response.json(
      { error: 'Search is unavailable right now.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}
