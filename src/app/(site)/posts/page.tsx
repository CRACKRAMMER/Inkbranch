import type { Metadata } from 'next'

import { EntryList, type Entry } from '@/components/content/entry-list'
import { PageHeader } from '@/components/content/page-header'
import { Pagination } from '@/components/content/pagination'
import { Container } from '@/components/site/container'
import { countContent, listContent, type ContentSummary } from '@/lib/content/queries'
import { pageCount, pageSlice, parsePage } from '@/lib/pagination'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate, yearIn } from '@/lib/utils/date'

/**
 * The writing index.
 *
 * Grouped by year, and the year is the only heading. A flat list of forty
 * dated rows loses the shape of the archive — whether the author wrote steadily
 * or in bursts, and when — which is the one thing a reader browsing back
 * through a body of work is trying to see.
 *
 * Descriptions are shown here but not on the home timeline. The home page is
 * for scanning what is new; this page is for choosing something to read, and
 * choosing needs more than a title.
 *
 * No `revalidate` below, deliberately. Reading `searchParams` opts the route
 * into per-request rendering, so a segment-level revalidate would be a
 * decoration that never fires — and a number in the file that does not do what
 * it says is worse than no number. What keeps the route cheap is the queries:
 * both are indexed, `listTags` and `getSettings` are `cache()`d for the
 * request, and the page reads twenty rows.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()
  const total = await countContent({ type: 'post' })

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Writing',
    description:
      settings.siteDescription ||
      `Everything published here${total > 0 ? ` — ${total} articles` : ''}.`,
    path: '/posts',
  })
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [params, settings] = await Promise.all([searchParams, getSettings()])
  const requested = parsePage(params.page)

  const total = await countContent({ type: 'post' })
  const { limit, offset, page } = pageSlice(requested, total)
  const posts = await listContent({ type: 'post', limit, offset })

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }

  const toEntry = (item: ContentSummary): Entry => ({
    href: item.url,
    title: item.title,
    dateLabel: formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short'),
    dateTime: toIsoDate(item.publishedAt ?? item.updatedAt),
    description: item.description,
    readingTime: item.readingTime,
    tags: item.tags,
  })

  const byYear = new Map<string, Entry[]>()
  for (const post of posts) {
    const year = yearIn(post.publishedAt ?? post.updatedAt, settings.timezone)
    const list = byYear.get(year)
    if (list) list.push(toEntry(post))
    else byYear.set(year, [toEntry(post)])
  }

  const pages = pageCount(total)

  return (
    <Container>
      <PageHeader
        title="Writing"
        description={settings.siteDescription || null}
        meta={
          total > 0
            ? `${total} ${total === 1 ? 'article' : 'articles'}`
            : undefined
        }
      />

      {posts.length === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">
          {total === 0
            ? 'Nothing has been published yet.'
            : 'That page is past the end of the archive.'}
        </p>
      ) : (
        <div className="flex flex-col gap-10 pt-8">
          {[...byYear.entries()].map(([year, entries]) => (
            <section key={year} aria-labelledby={`year-${year}`}>
              <h2 id={`year-${year}`} className="mb-1 font-mono text-xs text-ink-subtle">
                {year}
              </h2>
              <EntryList entries={entries} showDescription showTags />
            </section>
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={pages}
        hrefFor={(target) => (target === 1 ? '/posts' : `/posts?page=${target}`)}
      />
    </Container>
  )
}
