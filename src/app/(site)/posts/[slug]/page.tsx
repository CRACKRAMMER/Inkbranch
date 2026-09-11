import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { DocumentView } from '@/components/content/document-view'
import { getContent, getAdjacent } from '@/lib/content/queries'
import { readDocument } from '@/lib/content/reader'
import { getBacklinks } from '@/lib/graph/backlinks'
import { getRelatedPosts } from '@/lib/graph/related'
import { renderMarkdown } from '@/lib/markdown/renderer'
import {
  JsonLd,
  authorNodeId,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
} from '@/lib/seo/jsonld'
import { buildContentMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

/**
 * A published post.
 *
 * The reads below are concurrent, so the page waits on the slowest rather than
 * on their sum. `getContent` and `getSettings` are `cache()`d per request,
 * which is what stops the layout, this page and `generateMetadata` from each
 * issuing the same query.
 *
 * The body is read from the file, always. The index row caches the frontmatter
 * and the derived statistics; it has never held the prose, and that is the
 * property the whole design rests on.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const [doc, settings] = await Promise.all([getContent('post', slug), getSettings()])
  if (!doc) return { title: 'Not found' }

  return buildContentMetadata(siteIdentityFromSettings(settings), doc)
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  const doc = await getContent('post', slug)
  if (!doc) notFound()

  const [file, related, backlinks, adjacent, settings] = await Promise.all([
    readDocument(doc.path),
    getRelatedPosts(doc.id, { limit: 5 }),
    getBacklinks(doc.id),
    getAdjacent('post', doc.publishedAt, doc.slug),
    getSettings(),
  ])

  // The file can vanish between the index read and this one — a deletion in
  // another process — and `notFound()` is the honest answer rather than an
  // empty article that still looks published.
  if (!file) notFound()

  const { html } = await renderMarkdown(file.body)
  const site = siteIdentityFromSettings(settings)

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
            { name: 'Writing', url: '/posts' },
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
        section="/posts"
      />
    </>
  )
}
