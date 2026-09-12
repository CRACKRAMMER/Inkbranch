import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import { getAdminTag, listAdminTags } from '@/lib/admin/queries'
import { documentsWithTag } from '@/lib/admin/tags'
import { segmentForType } from '@/lib/admin/routes'
import { safeTagColor } from '@/lib/utils/tag-color'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { StatusBadge } from '@/components/admin/status-badge'
import { TagOperations } from '@/components/admin/tag-operations'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const tag = await getAdminTag(slug)
  return { title: tag ? `Tag · ${tag.name}` : 'Tag' }
}

/**
 * One tag: what it is on, and what can be done to it.
 *
 * The documents are listed first because they are the reason a rename is a
 * decision rather than a keystroke — this is the page that shows the blast
 * radius before the dialog asks for confirmation, and it is the list you would
 * work through by hand if the bulk operation half-failed.
 */
export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser()

  const { slug } = await params
  const tag = await getAdminTag(slug)
  if (!tag) notFound()

  const [documents, allTags] = await Promise.all([
    documentsWithTag(tag.slug),
    listAdminTags(),
  ])

  const others = allTags
    .filter((entry) => entry.slug !== tag.slug)
    .map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      contentCount: entry.contentCount,
    }))

  const drafts = documents.length - tag.publishedCount

  // The column is shown as stored below, because an admin page that hides what
  // is actually in the database cannot be used to diagnose it. What is rendered
  // as a colour is the validated value: `tag.color` is interpolated into a
  // `style` attribute, and a value written by a direct SQL import never passed
  // the validator. `safeTagColor` is the same guard the public site's dot uses.
  const color = safeTagColor(tag.color)

  return (
    <Page
      eyebrow="Tag"
      title={tag.name}
      description={
        <>
          Written <span className="font-mono">/tags/{tag.slug}</span> on the public site. The tag
          exists because {documents.length} document
          {documents.length === 1 ? '' : 's'} list it in their frontmatter — editing the tag here
          edits those files.
        </>
      }
      actions={
        <Link href="/admin/tags" className="text-sm text-ink-muted hover:text-brand">
          ← All tags
        </Link>
      }
    >
      <StatRow>
        <StatCell>
          <Stat label="Documents" value={documents.length} />
        </StatCell>
        <StatCell>
          <Stat label="Published" value={tag.publishedCount} />
        </StatCell>
        <StatCell>
          <Stat
            label="Drafts and other"
            value={drafts}
            note={drafts > 0 ? 'Not reachable by a reader' : undefined}
          />
        </StatCell>
        <StatCell>
          <Stat label="Slug" value={<span className="font-mono text-base">{tag.slug}</span>} />
        </StatCell>
      </StatRow>

      <Section
        title="Documents"
        description="Every document listing this tag, at any status."
      >
        {documents.length === 0 ? (
          <InlineNote>
            No document lists this tag. It is a row left over from a previous rename or from a tag
            removed by hand — deleting it changes no files.
          </InlineNote>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Documents carrying the tag {tag.name}</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Document
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Type
                  </th>
                  <th scope="col" className="py-2 text-right font-medium text-ink-muted">
                    <span className="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-line last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <Link
                        href={`/admin/${segmentForType(document.type)}/${document.slug}/edit`}
                        className="text-ink hover:text-brand"
                      >
                        {document.title}
                      </Link>
                      <span className="mt-0.5 block font-mono text-xs text-ink-subtle">
                        {document.path}
                      </span>
                    </th>
                    <td className="py-2 pr-3">
                      <StatusBadge status={document.status} />
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{document.type}</td>
                    <td className="py-2 text-right">
                      <Link
                        href={`/admin/${segmentForType(document.type)}/${document.slug}/edit`}
                        className="text-xs text-brand underline underline-offset-2"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Change this tag"
        description="Each of these rewrites the frontmatter of every document above and then reconciles the index."
      >
        <TagOperations
          tag={{
            slug: tag.slug,
            name: tag.name,
            contentCount: documents.length,
            publishedCount: tag.publishedCount,
          }}
          others={others}
        />
        <div className="mt-4 space-y-2 text-xs leading-relaxed text-ink-muted">
          <p>
            Files are lock-protected and replaced atomically one at a time, but the run as a whole
            is not a transaction: if one document cannot be written it is skipped, the rest still
            go through, and the report says which. Every rewritten document keeps a revision in its
            own history, so a change can be undone one file at a time.
          </p>
          <p>
            A tag&rsquo;s colour and description have no counterpart in the frontmatter, so they are
            carried across a rename here and are lost on a merge — the surviving tag keeps its own.
          </p>
        </div>
      </Section>

      {tag.color || tag.description ? (
        <Section title="Appearance">
          <div className="flex flex-wrap items-center gap-4 border-y border-line py-3 text-sm">
            {tag.color ? (
              <span className="inline-flex items-center gap-2 text-ink-muted">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 rounded-full"
                  style={color ? { backgroundColor: color } : undefined}
                />
                <span className="font-mono text-xs">{tag.color}</span>
                {color ? null : (
                  <span className="text-ink-subtle">
                    Not a hex colour, so the site derives one from the slug instead.
                  </span>
                )}
              </span>
            ) : (
              <span className="text-ink-subtle">No colour set; the site derives one from the slug.</span>
            )}
            {tag.description ? <span className="text-ink-muted">{tag.description}</span> : null}
          </div>
          <p className="mt-2 text-xs text-ink-subtle">
            Set in the database rather than in the documents, so nothing on this page can change
            them yet.
          </p>
        </Section>
      ) : null}

      <p className="mt-8 text-xs text-ink-subtle">
        Tags are derived from the documents: a row exists here only while some file lists it.
      </p>
    </Page>
  )
}
