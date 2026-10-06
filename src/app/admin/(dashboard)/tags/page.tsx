import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth/session'
import { listAdminTags } from '@/lib/admin/queries'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { Badge } from '@/components/ui/badge'
import { safeTagColor } from '@/lib/utils/tag-color'

export const metadata: Metadata = { title: 'Tags' }

/**
 * Tags, with the counts an editor actually needs.
 *
 * Both counts are shown because they answer different questions: `documents` is
 * what a rename would touch, and `published` is what a reader can reach today. A
 * tag used only by drafts looks unused on the public site and is not.
 *
 * The operations live on the tag's own page rather than in this table. Each one
 * rewrites files, and a table row is not enough room to say what that means.
 */
export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireUser()

  const [{ q }, tags] = await Promise.all([searchParams, listAdminTags()])

  const query = q?.trim().toLowerCase() ?? ''
  const filtered = query
    ? tags.filter(
        (tag) =>
          tag.name.toLowerCase().includes(query) || tag.slug.toLowerCase().includes(query),
      )
    : tags

  const unused = tags.filter((tag) => tag.contentCount === 0)

  return (
    <Page
      title="Tags"
      description="A tag exists because a document’s frontmatter says so. Everything on this page is derived from that, and every change here edits the files."
    >
      <StatRow>
        <StatCell>
          <Stat label="Tags" value={tags.length} />
        </StatCell>
        <StatCell>
          <Stat label="In use" value={tags.length - unused.length} />
        </StatCell>
        <StatCell>
          <Stat
            label="Unused"
            value={unused.length}
            note={unused.length > 0 ? 'Carried by no document' : undefined}
          />
        </StatCell>
        <StatCell>
          <Stat
            label="Most used"
            value={tags[0]?.name ?? '—'}
            note={tags[0] ? `${tags[0].contentCount} documents` : undefined}
          />
        </StatCell>
      </StatRow>

      <Section
        title="All tags"
        description="Ordered by how many documents carry each one."
        actions={
          <form method="get" className="flex items-center gap-2">
            <label className="sr-only" htmlFor="tag-search">
              Filter tags
            </label>
            <input
              id="tag-search"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Filter"
              className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
            />
            <button
              type="submit"
              className="h-8 rounded-md border border-line-strong px-2.5 text-xs text-ink hover:bg-sunken"
            >
              Filter
            </button>
          </form>
        }
      >
        {tags.length === 0 ? (
          <InlineNote>
            No tags exist yet. A tag is created when a document is saved with a{' '}
            <span className="font-mono">tags:</span> list and the index is reconciled — add one in
            the editor, or run a sync from System if the files already have them.
          </InlineNote>
        ) : filtered.length === 0 ? (
          <InlineNote>No tag matches “{q}”.</InlineNote>
        ) : (
          <div className="relative overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Every tag, with the number of documents carrying it
              </caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Tag
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Slug
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium text-ink-muted">
                    Documents
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium text-ink-muted">
                    Published
                  </th>
                  <th scope="col" className="py-2 text-right font-medium text-ink-muted">
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tag) => {
                  // The swatch is painted from a column no form on this screen
                  // writes, so it goes through the same guard the public dot
                  // uses before it reaches a `style` attribute — a colour that
                  // predates the validator, or one written by a direct SQL
                  // import, must not reach CSS. A refused value draws no swatch.
                  const color = safeTagColor(tag.color)

                  return (
                    <tr key={tag.id} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <Link
                          href={`/admin/tags/${tag.slug}`}
                          className="text-ink hover:text-brand"
                        >
                          {tag.name}
                        </Link>
                        {color ? (
                          <span
                            aria-hidden="true"
                            className="ml-2 inline-block size-2 rounded-full align-middle"
                            style={{ backgroundColor: color }}
                          />
                        ) : null}
                      </th>
                      <td className="py-2 pr-3 font-mono text-xs text-ink-muted">{tag.slug}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                        {tag.contentCount === 0 ? (
                          <Badge variant="outline">unused</Badge>
                        ) : (
                          tag.contentCount
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                        {tag.publishedCount}
                      </td>
                      <td className="py-2 text-right">
                        <Link
                          href={`/admin/tags/${tag.slug}`}
                          className="text-xs text-brand underline underline-offset-2"
                        >
                          Manage
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {unused.length > 0 ? (
        <InlineNote>
          {unused.length} tag{unused.length === 1 ? '' : 's'} that no document carries. They are
          left over from a previous rename or from a tag removed by hand, and they can be deleted
          from their own page — deleting one rewrites no files, because nothing references it.
        </InlineNote>
      ) : null}
    </Page>
  )
}
