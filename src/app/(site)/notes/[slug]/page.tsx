import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CoverImage } from '@/components/content/cover-image'
import { DocumentFacts, DocumentView } from '@/components/content/document-view'
import { getContent, getAdjacent } from '@/lib/content/queries'
import { readDocument } from '@/lib/content/reader'
import { describeImage, renderDocument } from '@/lib/content/render'
import { getBacklinks } from '@/lib/graph/backlinks'
import { getRelatedPosts } from '@/lib/graph/related'
import {
  JsonLd,
  authorNodeId,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
} from '@/lib/seo/jsonld'
import { buildContentMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'

/**
 * A note.
 *
 * Identical to a post except for what the header says. A note is a document
 * that is *maintained* rather than published, so the header reports when it was
 * last tended alongside when it was planted. That difference is the whole
 * reason the two types exist: on a post, an update date is an exception worth
 * noting; on a note, it is the normal state and the more useful of the two
 * dates.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const [doc, settings] = await Promise.all([getContent('note', slug), getSettings()])
  if (!doc) return { title: 'Not found' }

  return buildContentMetadata(siteIdentityFromSettings(settings), doc)
}

export default async function NotePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  const doc = await getContent('note', slug)
  if (!doc) notFound()

  const [file, related, backlinks, adjacent, settings, cover] = await Promise.all([
    readDocument(doc.path),
    getRelatedPosts(doc.id, { limit: 5 }),
    getBacklinks(doc.id),
    getAdjacent('note', doc.publishedAt, doc.slug),
    getSettings(),
    describeImage(doc.cover),
  ])

  if (!file) notFound()

  const { html } = await renderDocument(file.body)
  const site = siteIdentityFromSettings(settings)
  const context = { locale: settings.locale, timeZone: settings.timezone }

  return (
    <>
      <JsonLd
        data={[
          buildArticleJsonLd({
            site,
            doc,
            // The author node the about page publishes, referenced rather
            // than repeated: `authorNodeId` returns null when there is no
            // author name, and the about page withholds the node on the same
            // condition, so the two are always published together.
            authorId: authorNodeId(settings.authorName),
          }),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: 'Notes', url: '/notes' },
            { name: doc.title, url: doc.url },
          ]),
        ]}
      />
      <DocumentView
        doc={doc}
        html={html}
        related={related}
        backlinks={backlinks}
        adjacent={adjacent}
        settings={settings}
        section="/notes"
        cover={doc.cover ? <CoverImage href={doc.cover} image={cover} /> : null}
        headerExtra={
          <DocumentFacts
            facts={[
              {
                label: 'Planted',
                value: doc.publishedAt
                  ? formatDate(doc.publishedAt, context, 'long')
                  : 'Undated',
              },
              {
                label: 'Tended',
                value: formatRelative(doc.updatedAt, { ...context, now: new Date() }),
              },
            ]}
          />
        }
      />
    </>
  )
}
