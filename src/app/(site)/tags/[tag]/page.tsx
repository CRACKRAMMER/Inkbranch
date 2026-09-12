import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EntryList, type Entry } from '@/components/content/entry-list'
import { PageHeader } from '@/components/content/page-header'
import { Pagination } from '@/components/content/pagination'
import { TagDot } from '@/components/content/tag-dot'
import { Container } from '@/components/site/container'
import {
  countContent,
  getTag,
  listContent,
  listTags,
  type ContentSummary,
} from '@/lib/content/queries'
import { pageCount, pageSlice, parsePage } from '@/lib/pagination'
import { groupHits } from '@/lib/search/group'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate } from '@/lib/utils/date'

/**
 * Everything carrying one tag.
 *
 * The tag is looked up by slug and a slug with nothing behind it is a 404, not
 * an empty page. `getTag` only returns tags that have published content, so
 * "this tag exists but is empty" is a state that cannot reach this route — and
 * a reader who follows a stale link from a search engine gets an honest "gone"
 * rather than a page that implies the topic exists and has nothing in it.
 *
 * ## The results are grouped by kind
 *
 * §46 asks for a tag page that is not a plain list of articles, and names the
 * three groups it wants under the count: articles, notes, projects. A tag is
 * the one place on this site where the three kinds genuinely meet — a topic is
 * a topic whether it was written up as a post or planted as a note — so the
 * grouping is what the page is for, not decoration on top of it.
 *
 * `groupHits` is the same function the search page groups with, so the headings
 * cannot say one thing on `/search` and another here, and `CONTENT_TYPES`
 * decides the order for both.
 *
 * The group headings carry no count, deliberately. This page paginates, so a
 * heading's count would be a count of the rows on *this page* sitting directly
 * under a total for all of them — two numbers about different things, one line
 * apart. The total at the top is the count, and it is the honest one.
 *
 * The related topics at the foot are computed from this page's own results
 * rather than queried. Every tag on a result is already loaded, so counting
 * them costs a loop over at most a page of rows, and it gives the reader
 * somewhere to go that is genuinely adjacent — which the global tag list,
 * ordered by size, does not.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tag: string }>
}): Promise<Metadata> {
  const [{ tag }, settings] = await Promise.all([params, getSettings()])
  const found = await getTag(tag)
  if (!found) return { title: 'Not found' }

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: found.description || `#${found.name}`,
    description:
      found.description ||
      `${found.count} ${found.count === 1 ? 'entry' : 'entries'} tagged “${found.name}”.`,
    path: `/tags/${encodeURIComponent(found.slug)}`,
    // The page and the feed are two views of one topic, so they are addressed
    // by one slug and advertised together: a reader who has arrived at the
    // topic should not have to guess that a feed for it exists.
    feed: `/rss/${encodeURIComponent(found.slug)}.xml`,
  })
}

export default async function TagPage({
  params,
  searchParams,
}: {
  params: Promise<{ tag: string }>
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [{ tag }, search, settings] = await Promise.all([
    params,
    searchParams,
    getSettings(),
  ])

  const found = await getTag(tag)
  if (!found) notFound()

  const requested = parsePage(search.page)
  const total = await countContent({ tag: found.slug })
  const { limit, offset, page } = pageSlice(requested, total)

  const [items, allTags] = await Promise.all([
    listContent({ tag: found.slug, limit, offset }),
    listTags(),
  ])

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }
  const groups = groupHits(items)

  const toEntry = (item: ContentSummary): Entry => ({
    href: item.url,
    title: item.title,
    dateLabel: formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short'),
    dateTime: toIsoDate(item.publishedAt ?? item.updatedAt),
    description: item.description,
    readingTime: item.readingTime,
    tags: item.tags,
    /*
      No `typeLabel`. It used to be set whenever a page happened to mix types,
      because a flat list had to say which kind each row was. The group heading
      above each list says it once instead, which is the same information told
      without repeating it on every row.
    */
  })

  /*
   * Co-occurring tags, from the rows already in hand.
   *
   * This tag is excluded because "related to itself" is not a suggestion, and
   * the list is capped at eight because a suggestion strip longer than the
   * results it sits under stops being a suggestion.
   */
  const coOccurring = new Map<string, { name: string; slug: string; color: string | null; count: number }>()
  for (const item of items) {
    for (const other of item.tags) {
      if (other.slug === found.slug) continue
      const seen = coOccurring.get(other.slug)
      if (seen) seen.count += 1
      else coOccurring.set(other.slug, { ...other, count: 1 })
    }
  }
  const related = [...coOccurring.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8)

  const pages = pageCount(total)
  const base = `/tags/${encodeURIComponent(found.slug)}`

  return (
    <Container>
      <PageHeader
        title={found.name}
        description={found.description}
        meta={
          <>
            <TagDot slug={found.slug} color={found.color} />
            <span className="ml-2">
              {total} {total === 1 ? 'entry' : 'entries'} ·{' '}
              <Link href="/tags" className="transition-colors duration-150 hover:text-ink">
                all topics
              </Link>
            </span>
          </>
        }
      />

      {items.length === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">That page is past the end of the list.</p>
      ) : (
        <div className="flex flex-col gap-10 pt-6">
          {groups.map((group) => (
            <section key={group.type} aria-labelledby={`tag-group-${group.type}`}>
              <h2
                id={`tag-group-${group.type}`}
                className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-subtle"
              >
                {group.label}
              </h2>
              <EntryList entries={group.hits.map(toEntry)} showDescription showTags />
            </section>
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={pages}
        hrefFor={(target) => (target === 1 ? base : `${base}?page=${target}`)}
      />

      {related.length > 0 && pages === 1 ? (
        <section aria-labelledby="related-topics" className="mt-14 border-t border-line pt-5">
          <h2
            id="related-topics"
            className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle"
          >
            Often alongside
          </h2>
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {related.map((other) => {
              // The global list is what knows a tag's real size; the co-occurrence
              // count above is only "within the page of results we happened to
              // load", which would understate a busy tag on a paginated page.
              const global = allTags.find((entry) => entry.slug === other.slug)
              return (
                <li key={other.slug} className="flex items-center gap-1.5">
                  <TagDot slug={other.slug} color={other.color} />
                  <Link
                    href={`/tags/${encodeURIComponent(other.slug)}`}
                    className="text-sm text-ink-muted transition-colors duration-150 hover:text-ink"
                  >
                    {other.name}
                  </Link>
                  {global ? (
                    <span className="font-mono text-xs text-ink-subtle tabular-nums">
                      {global.count}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </Container>
  )
}
