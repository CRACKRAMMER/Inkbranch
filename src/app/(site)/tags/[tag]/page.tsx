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
 * The related topics at the foot are computed from this page's own results
 * rather than queried. Every tag on a result is already loaded, so counting
 * them costs a loop over at most a page of rows, and it gives the reader
 * somewhere to go that is genuinely adjacent — which the global tag list,
 * ordered by size, does not.
 */
export const revalidate = 300

/** The type label shown before a title when a tag spans more than one type. */
const TYPE_LABELS: Record<string, string> = {
  post: 'Article',
  note: 'Note',
  project: 'Project',
}

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
  const spansTypes = new Set(items.map((item) => item.type)).size > 1

  const toEntry = (item: ContentSummary): Entry => ({
    href: item.url,
    title: item.title,
    dateLabel: formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short'),
    dateTime: toIsoDate(item.publishedAt ?? item.updatedAt),
    description: item.description,
    readingTime: item.readingTime,
    tags: item.tags,
    typeLabel: spansTypes ? TYPE_LABELS[item.type] : undefined,
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
        <div className="pt-6">
          <EntryList entries={items.map(toEntry)} showDescription showTags />
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
