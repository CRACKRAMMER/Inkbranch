import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { TagList } from '@/components/content/tag-list'
import { Container } from '@/components/site/container'
import { search, type SearchHit } from '@/lib/search'
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '@/lib/search/provider'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate } from '@/lib/utils/date'
import { tagSlug } from '@/lib/utils/slug'

/**
 * Search.
 *
 * A server-rendered page rather than a client-side one, which is the decision
 * worth recording. The command palette already searches from the keyboard, and
 * it has to call an API because it lives in the browser. This page does not:
 * reading `?q=` and calling the provider during the render means results are in
 * the first HTML, they work without JavaScript, and every query has a URL that
 * can be bookmarked, shared and reloaded — none of which a client-side search
 * box gives you.
 *
 * The two inputs are sanitised by the provider and are safe to inject:
 * `highlight()` escapes every slice of text it copies and emits `<mark>` as the
 * only markup, so `titleHtml` and `excerptHtml` cannot carry a script tag out
 * of a document body. That is the one place in this codebase where
 * `dangerouslySetInnerHTML` is allowed outside the article renderer.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Search',
    description: 'Search everything published here.',
    path: '/search',
    // A search results page behind a query string is a page of duplicates as
    // far as a crawler is concerned, and it has nothing to offer that the
    // indexes do not.
    noindex: true,
  })
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  const [params, settings] = await Promise.all([searchParams, getSettings()])

  const raw = Array.isArray(params.q) ? params.q[0] : params.q
  const query = (raw ?? '').trim()
  const context = { locale: settings.locale, timeZone: settings.timezone }

  const result =
    settings.searchEnabled && query.length > 0
      ? await search({ q: query, limit: DEFAULT_SEARCH_LIMIT })
      : null

  const overLimit = result !== null && result.total > result.hits.length

  return (
    <Container>
      <PageHeader
        title="Search"
        description="Search titles, tags, headings and body text across every published document."
        meta={
          result
            ? `${result.total} ${result.total === 1 ? 'result' : 'results'} · ranked by ${result.provider} in ${result.took}ms`
            : undefined
        }
      />

      {!settings.searchEnabled ? (
        <p className="py-16 text-sm text-ink-subtle">
          Search is turned off on this site.
        </p>
      ) : (
        <>
          {/*
            A plain `<form method="get">`, not a controlled React input.
            Submitting it navigates to `?q=…`, which is what makes the results
            shareable and what makes this work with JavaScript disabled — the
            browser's own form submission, not a handler.
          */}
          <form action="/search" method="get" role="search" className="mt-8">
            <label htmlFor="search-input" className="sr-only">
              Search
            </label>
            <div className="flex items-center gap-3 border-b border-line pb-3 focus-within:border-ink">
              <input
                id="search-input"
                type="search"
                name="q"
                defaultValue={query}
                placeholder="Search…"
                // The whole purpose of navigating to this page is to type a
                // query, so the field takes focus. Autofocus is a defect when
                // it steals focus from a page the reader was already reading;
                // here the reader asked for this page and nothing else on it
                // is focusable.
                autoFocus
                autoComplete="off"
                maxLength={200}
                className="w-full bg-transparent text-lg text-ink outline-none placeholder:text-ink-subtle"
              />
              <button
                type="submit"
                className="shrink-0 text-sm text-ink-muted transition-colors duration-150 hover:text-brand"
              >
                Search
              </button>
            </div>
          </form>

          {query === '' ? (
            <p className="py-16 text-sm text-ink-subtle">
              Type something to search. Multi-word queries match documents
              containing every term; quoted phrases match exactly.
            </p>
          ) : result === null || result.hits.length === 0 ? (
            <div className="py-16">
              <p className="text-sm text-ink-muted">
                Nothing found for <span className="text-ink">“{query}”</span>.
              </p>
              <p className="mt-2 text-sm text-ink-subtle">
                Try fewer words, or browse the{' '}
                <Link href="/tags" className="transition-colors duration-150 hover:text-ink">
                  topics
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              {result.notice ? (
                <p className="mt-6 border-l-2 border-line-strong pl-3 text-xs text-ink-muted">
                  {result.notice}
                </p>
              ) : null}

              <ul className="flex flex-col pt-4">
                {result.hits.map((hit) => (
                  <li
                    key={`${hit.type}:${hit.slug}`}
                    className="border-b border-line py-6 last:border-b-0"
                  >
                    <Result hit={hit} context={context} />
                  </li>
                ))}
              </ul>

              {overLimit ? (
                <p className="mt-6 text-xs text-ink-subtle">
                  Showing {result.hits.length} of {result.total}. The first{' '}
                  {MAX_SEARCH_LIMIT} are the ceiling this provider will answer
                  in one request — narrow the query to see the rest.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </Container>
  )
}

const TYPE_LABELS: Record<string, string> = {
  post: 'Article',
  note: 'Note',
  project: 'Project',
}

/**
 * One result.
 *
 * `titleHtml` and `excerptHtml` come from the search provider with `<mark>`
 * around matched terms and everything else escaped — see the page docstring.
 */
function Result({
  hit,
  context,
}: {
  hit: SearchHit
  context: { locale: string; timeZone: string }
}) {
  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="font-mono uppercase tracking-wider text-ink-subtle">
          {TYPE_LABELS[hit.type] ?? hit.type}
        </span>
        {hit.publishedAt ? (
          <time dateTime={hit.publishedAt.toISOString()} className="text-ink-subtle">
            {formatDate(hit.publishedAt, context, 'medium')}
          </time>
        ) : null}
        {hit.matched.length > 0 && !hit.matched.includes('title') ? (
          <span className="text-ink-subtle">matched in {hit.matched.join(', ')}</span>
        ) : null}
      </div>

      <h2 className="mt-2 text-base leading-snug">
        <Link
          href={hit.url}
          className="search-hit__title text-ink transition-colors duration-150 hover:text-brand"
          dangerouslySetInnerHTML={{ __html: hit.titleHtml }}
        />
      </h2>

      {hit.excerptHtml ? (
        <p
          className="search-hit__excerpt mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-muted"
          dangerouslySetInnerHTML={{ __html: hit.excerptHtml }}
        />
      ) : hit.description ? (
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-muted">
          {hit.description}
        </p>
      ) : null}

      {hit.tags.length > 0 ? (
        <TagList
          // Search carries tag *names*, because that is what it indexes. The
          // slug is derived from the name by the same function the sync engine
          // uses, so the link lands on the real tag page rather than on a
          // URL-encoded name.
          tags={hit.tags.map((name) => ({
            name,
            slug: tagSlug(name),
            color: null,
          }))}
          className="mt-2.5"
        />
      ) : null}
    </article>
  )
}
