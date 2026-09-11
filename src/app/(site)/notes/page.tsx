import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { Pagination } from '@/components/content/pagination'
import { TagList } from '@/components/content/tag-list'
import { Container } from '@/components/site/container'
import { countContent, listContent } from '@/lib/content/queries'
import { pageCount, pageSlice, parsePage } from '@/lib/pagination'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'

/**
 * The digital garden.
 *
 * A note is a document that is *maintained* rather than published, and the
 * layout says so. Each entry leads with when it was last changed and puts the
 * planting date second, where the writing index does the opposite — on a note,
 * the update date is the normal state and the more useful of the two.
 *
 * It is a two-column grid rather than a dated timeline. A timeline implies an
 * order worth reading in; a garden has no order, and a reader arrives looking
 * for a topic rather than for the newest thing. The grid also lets each note
 * carry a description without the rows turning into paragraphs.
 *
 * Sorted by last update, which `listContent` does not do — a note edited today
 * that was planted two years ago belongs at the top of this page, and sorting
 * by publication date would bury it.
 */
export const revalidate = 300

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Notes',
    description:
      'Short notes, tended rather than published — things worth writing down before they are worth an article.',
    path: '/notes',
  })
}

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [params, settings] = await Promise.all([searchParams, getSettings()])
  const requested = parsePage(params.page)

  const total = await countContent({ type: 'note' })
  const { limit, offset, page } = pageSlice(requested, total)

  // Ordered by last update, not publication — a note edited today that was
  // planted two years ago belongs at the top of this page.
  const notes = await listContent({ type: 'note', limit, offset, sort: 'updated' })

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }
  const now = new Date()
  const pages = pageCount(total)

  return (
    <Container>
      <PageHeader
        title="Notes"
        description="Short notes, tended rather than published — things worth writing down before they are worth an article. Dated by when they last changed."
        meta={total > 0 ? `${total} ${total === 1 ? 'note' : 'notes'}` : undefined}
      />

      {notes.length === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">
          {total === 0 ? 'No notes yet.' : 'That page is past the end of the garden.'}
        </p>
      ) : (
        <ul className="grid gap-x-10 gap-y-8 pt-10 sm:grid-cols-2">
          {notes.map((note) => (
            <li key={note.slug} className="border-l border-line pl-4">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs">
                <span className="text-brand">
                  Updated {formatRelative(note.updatedAt, { ...dateContext, now })}
                </span>
                {note.publishedAt ? (
                  <span className="text-ink-subtle">
                    planted {formatDate(note.publishedAt, dateContext, 'short')}
                  </span>
                ) : null}
              </div>

              <h2 className="mt-1.5 text-base leading-snug">
                <Link
                  href={note.url}
                  className="text-ink transition-colors duration-150 hover:text-brand"
                >
                  {note.title}
                </Link>
              </h2>

              {note.description ? (
                <p className="mt-1.5 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
                  {note.description}
                </p>
              ) : null}

              {note.tags.length > 0 ? (
                <TagList tags={note.tags} className="mt-2.5" />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        totalPages={pages}
        hrefFor={(target) => (target === 1 ? '/notes' : `/notes?page=${target}`)}
      />
    </Container>
  )
}
