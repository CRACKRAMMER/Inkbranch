import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { Container } from '@/components/site/container'
import { listArchive } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate } from '@/lib/utils/date'

/**
 * Everything, by year.
 *
 * The one page that is deliberately not paginated. Its whole purpose is to be
 * the complete record — a reader comes here to find the shape of the whole
 * body of work, and an archive that stops after twenty entries and asks you to
 * click for more is not an archive.
 *
 * Denser than any other list on the site: no descriptions, no tags, no reading
 * times. Once a reader has decided to scroll the whole thing, every extra
 * column per row doubles the length of the page and halves how much of it fits
 * on screen.
 *
 * Undated documents get their own group at the end rather than being dropped.
 * A note can legitimately have no date, and leaving them out would make this
 * page quietly incomplete — which is the one thing an archive must not be.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Archive',
    description: 'Everything published here, newest first, as one list.',
    path: '/archive',
  })
}

export default async function ArchivePage() {
  const [settings, groups] = await Promise.all([getSettings(), listArchive()])

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <Container>
      <PageHeader
        title="Archive"
        description="Everything published here, newest first."
        meta={total > 0 ? `${total} ${total === 1 ? 'entry' : 'entries'}` : undefined}
      />

      {total === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">Nothing has been published yet.</p>
      ) : (
        <div className="flex flex-col gap-10 pt-8">
          {groups.map((group) => (
            <section key={group.year || 'undated'} aria-labelledby={`y-${group.year || 'u'}`}>
              <h2
                id={`y-${group.year || 'u'}`}
                className="mb-2 border-b border-line pb-2 font-mono text-sm text-ink-subtle"
              >
                {group.year || 'Undated'}
                <span className="ml-3 text-xs">
                  {group.items.length} {group.items.length === 1 ? 'entry' : 'entries'}
                </span>
              </h2>

              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li
                    key={`${item.type}:${item.slug}`}
                    className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-4 py-2 sm:grid-cols-[5.5rem_1fr]"
                  >
                    <time
                      dateTime={toIsoDate(item.publishedAt ?? item.updatedAt)}
                      className="font-mono text-xs text-ink-subtle"
                    >
                      {formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short')}
                    </time>

                    <Link
                      href={item.url}
                      className="text-sm leading-snug text-ink-muted transition-colors duration-150 hover:text-brand"
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Container>
  )
}
