import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { DocumentFacts, DocumentView } from '@/components/content/document-view'
import { getContent, getAdjacent } from '@/lib/content/queries'
import { readDocument } from '@/lib/content/reader'
import { getBacklinks } from '@/lib/graph/backlinks'
import { getRelatedPosts } from '@/lib/graph/related'
import { renderMarkdown } from '@/lib/markdown/renderer'
import { JsonLd, buildArticleJsonLd, buildBreadcrumbJsonLd } from '@/lib/seo/jsonld'
import { buildContentMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate } from '@/lib/utils/date'

/**
 * A project.
 *
 * The header carries the facts a reader of a project page wants before the
 * prose: whether it is maintained or abandoned, what it is built from, and
 * where to find the code. That is a different question from "when was this
 * published", which is why `projectStatus` and `stack` exist in the frontmatter
 * at all rather than being written into the body.
 */
export const revalidate = 300

/** Human labels for the stored status values. */
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  maintained: 'Maintained',
  experiment: 'Experiment',
  archived: 'Archived',
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const [doc, settings] = await Promise.all([getContent('project', slug), getSettings()])
  if (!doc) return { title: 'Not found' }

  return buildContentMetadata(siteIdentityFromSettings(settings), doc)
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  const doc = await getContent('project', slug)
  if (!doc) notFound()

  const [file, related, backlinks, adjacent, settings] = await Promise.all([
    readDocument(doc.path),
    getRelatedPosts(doc.id, { limit: 5 }),
    getBacklinks(doc.id),
    getAdjacent('project', doc.publishedAt, doc.slug),
    getSettings(),
  ])

  if (!file) notFound()

  const { html } = await renderMarkdown(file.body)
  const site = siteIdentityFromSettings(settings)
  const context = { locale: settings.locale, timeZone: settings.timezone }

  const status = doc.projectStatus
    ? (STATUS_LABELS[doc.projectStatus] ?? doc.projectStatus)
    : null

  return (
    <>
      <JsonLd
        data={[
          buildArticleJsonLd({ site, doc }),
          buildBreadcrumbJsonLd([
            { name: 'Home', url: '/' },
            { name: 'Projects', url: '/projects' },
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
        section="/projects"
        headerExtra={
          <DocumentFacts
            facts={[
              { label: 'Status', value: status },
              {
                label: 'Started',
                value: doc.startedAt
                  ? formatDate(doc.startedAt, context, 'medium')
                  : null,
              },
              {
                label: 'Built with',
                value: doc.techStack.length > 0 ? doc.techStack.join(', ') : null,
              },
              {
                label: 'Code',
                value: doc.repoUrl ? (
                  <a
                    href={doc.repoUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="text-brand hover:underline"
                  >
                    Repository
                  </a>
                ) : null,
              },
              {
                label: 'Site',
                value: doc.websiteUrl ? (
                  <a
                    href={doc.websiteUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="text-brand hover:underline"
                  >
                    {doc.websiteUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : null,
              },
            ]}
          />
        }
      />
    </>
  )
}
