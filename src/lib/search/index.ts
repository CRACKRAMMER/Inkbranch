import { env } from '@/env'
import { localSearchProvider } from './local'
import type { SearchProvider, SearchQuery, SearchResult } from './provider'

/**
 * Which search backend answers queries.
 *
 * The whole point of `SearchProvider` is that this file is the only place that
 * knows. Swapping to Meilisearch means adding `./meilisearch.ts`, one case
 * below, and `SEARCH_PROVIDER=meilisearch` — no page, route or component
 * changes, because none of them import anything from this directory except
 * `search()`.
 *
 * Re-exported rather than re-implemented: a wrapper that only forwards its
 * arguments is a place for the two to drift apart.
 */
export type {
  MatchField,
  SearchDocument,
  SearchHit,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from './provider'
export { MAX_SEARCH_LIMIT } from './provider'

let provider: SearchProvider | null = null

/**
 * The configured provider.
 *
 * Constructed once per process. A remote provider wants a long-lived client, and
 * the local one holds its index in module scope, so building a fresh instance
 * per call would throw both away.
 */
export function getSearchProvider(): SearchProvider {
  provider ??= createProvider()
  return provider
}

function createProvider(): SearchProvider {
  switch (env.SEARCH_PROVIDER) {
    case 'local':
      return localSearchProvider
    default: {
      // Unreachable while `SEARCH_PROVIDER` is a single-value enum, which is
      // the point: adding a second value to `src/env.ts` fails to compile here
      // until it is handled, rather than silently falling back to local.
      const unreachable: never = env.SEARCH_PROVIDER
      throw new Error(`Unsupported search provider: ${String(unreachable)}`)
    }
  }
}

/** Run a search through the configured provider. */
export function search(query: SearchQuery): Promise<SearchResult> {
  return getSearchProvider().search(query)
}

/** Name of the configured provider, for the system page and the health check. */
export function searchProviderName(): string {
  return getSearchProvider().name
}
