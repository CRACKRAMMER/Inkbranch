import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/content/page-header'
import { TagList } from '@/components/content/tag-list'
import { Container } from '@/components/site/container'
import { listSeries } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate } from '@/lib/utils/date'

/**
 * A series, in reading order.
 *
 * Numbered, because that is the whole difference between a series and a tag.
 * A tag is a set; a series is a sequence, and the numbers are the only thing
 * that says so — a reader who lands on part three first needs to know there is
 * a part one and where it is.
 *
 * Ordered oldest-first, which is the opposite of every other list on the site.
 * Reading order is chronological order, and a reader arriving here is at the
 * beginning, not looking for the newest thing.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ series: string }>
}): Promise<Metadata> {
  const [{ series }, settings] = await Promise.all([params, getSettings()])

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: series,
    description: `Every part of “${series}”, in reading order.`,
    path: `/series/${encodeURIComponent(series)}`,
  })
}

export default async function SeriesPage({
  params,
}: {
  params: Promise<{ series: string }>
}) {
  const [{ series }, settings] = await Promise.all([params, getSettings()])

  const parts = await listSeries(series)
  // A series name that matches nothing is a 404. `series` is a frontmatter
  // string with no table of its own, so there is no other existence check to
  // make — an empty list is the only evidence available, and rendering it as an
  // empty page would present a typo as a real, empty series.
  if (parts.length === 0) notFound()

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }

  return (
    <Container>
      <PageHeader
        title={series}
        description="Every part, in reading order."
        meta={`${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`}
      />

      <ol className="flex flex-col pt-6">
        {parts.map((part, index) => (
          <li
            key={part.slug}
            className="group grid grid-cols-[2rem_1fr] gap-x-4 border-b border-line py-5 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className="pt-0.5 font-mono text-sm text-ink-subtle tabular-nums"
            >
              {String(index + 1).padStart(2, '0')}
            </span>

            <div className="min-w-0">
              <h2 className="text-base leading-snug">
                <Link
                  href={part.url}
                  className="text-ink transition-colors duration-150 hover:text-brand"
                >
                  <span className="sr-only">Part {index + 1}: </span>
                  {part.title}
                </Link>
              </h2>

              {part.description ? (
                <p className="mt-1.5 max-w-[60ch] text-sm leading-relaxed text-ink-muted">
                  {part.description}
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <time
                  dateTime={toIsoDate(part.publishedAt ?? part.updatedAt)}
                  className="text-xs text-ink-subtle"
                >
                  {formatDate(part.publishedAt ?? part.updatedAt, dateContext, 'medium')}
                </time>
                {part.readingTime > 0 ? (
                  <span className="text-xs text-ink-subtle">{part.readingTime} min</span>
                ) : null}
                {part.tags.length > 0 ? <TagList tags={part.tags} /> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Container>
  )
}
