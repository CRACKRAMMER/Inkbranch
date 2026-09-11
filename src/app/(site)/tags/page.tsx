import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { TagDot } from '@/components/content/tag-dot'
import { Container } from '@/components/site/container'
import { listTags } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

/**
 * Every topic.
 *
 * Ordered by how much is behind each one, which `listTags` does. An
 * alphabetical list of tags is a phone book: it tells a reader what exists but
 * nothing about where the writing actually is, and on a personal site the
 * distribution is the interesting part — three tags with twenty posts each and
 * thirty with one says something about the author that the alphabet hides.
 *
 * The count is set in the same monospace as every other number on the site, so
 * the column of counts lines up and can be scanned without reading.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Topics',
    description: 'Everything published here, grouped by subject.',
    path: '/tags',
  })
}

export default async function TagsPage() {
  const tags = await listTags()
  const total = tags.reduce((sum, tag) => sum + tag.count, 0)

  return (
    <Container>
      <PageHeader
        title="Topics"
        description="Everything published here, grouped by subject — most written about first."
        meta={
          tags.length > 0
            ? `${tags.length} ${tags.length === 1 ? 'topic' : 'topics'} · ${total} ${
                total === 1 ? 'entry' : 'entries'
              }`
            : undefined
        }
      />

      {tags.length === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">No topics yet.</p>
      ) : (
        <ul className="grid gap-x-10 gap-y-1 pt-8 sm:grid-cols-2">
          {tags.map((tag) => (
            <li key={tag.slug}>
              <Link
                href={`/tags/${encodeURIComponent(tag.slug)}`}
                className="group flex items-baseline justify-between gap-4 border-b border-line py-3"
              >
                <span className="flex min-w-0 items-baseline gap-2.5">
                  <TagDot slug={tag.slug} color={tag.color} />
                  <span className="truncate text-sm text-ink-muted transition-colors duration-150 group-hover:text-ink">
                    {tag.name}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-ink-subtle tabular-nums">
                  {tag.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Container>
  )
}
