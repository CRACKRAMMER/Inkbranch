import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { GraphExplorer } from '@/components/graph/graph-explorer'
import { Container } from '@/components/site/container'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

/**
 * The knowledge graph.
 *
 * A server component that renders a heading and an island. It does no querying
 * and no layout — `GraphExplorer` fetches `/api/graph` from the browser and
 * loads the drawing code in a separate chunk, so opening this page and leaving
 * it costs one HTML response.
 *
 * A graph is only worth drawing when there is one. Below the threshold this
 * page says so plainly rather than rendering a handful of unconnected dots and
 * letting a reader conclude the site is broken. The threshold is low on
 * purpose — three documents that link to each other is already a graph.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Graph',
    description:
      'How the documents here reference each other, drawn as a graph.',
    path: '/graph',
  })
}

export default async function GraphPage() {
  const settings = await getSettings()

  return (
    <Container size="wide">
      <PageHeader
        title="Graph"
        description="How the documents here reference each other. Every line is a link written into a document — an internal link, or a wiki link — from one published page to another."
      />

      {!settings.graphEnabled ? (
        <p className="py-16 text-sm text-ink-subtle">
          The graph is turned off on this site. The links between documents are
          unaffected —{' '}
          <Link href="/archive" className="transition-colors duration-150 hover:text-ink">
            the archive
          </Link>{' '}
          has everything.
        </p>
      ) : (
        <div className="pt-8">
          <GraphExplorer />
        </div>
      )}

      <section
        aria-labelledby="graph-notes"
        className="mt-16 border-t border-line pt-5 text-xs leading-relaxed text-ink-subtle"
      >
        <h2 id="graph-notes" className="sr-only">
          About this graph
        </h2>
        <p className="max-w-[70ch]">
          Nodes are sized by how many other documents they connect to, and
          coloured by the rarest tag they carry. Documents with no links in or
          out are drawn at the edge — they are part of the picture, and hiding
          them would make a site with few links look better connected than it
          is. The layout is computed once and does not animate, so it is the
          same picture every time you come back.
        </p>
      </section>
    </Container>
  )
}
