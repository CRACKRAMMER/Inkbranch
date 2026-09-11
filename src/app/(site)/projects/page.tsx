import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { TagList } from '@/components/content/tag-list'
import { Container } from '@/components/site/container'
import { listContent, type ContentSummary } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate } from '@/lib/utils/date'

/**
 * Projects.
 *
 * Not paginated and not sorted by date. A personal site has a handful of
 * projects, the whole point of the page is that a reader can take in all of
 * them at once, and ordering them by when work started buries the one that is
 * actively maintained.
 *
 * They are ordered by status instead — live things first, archived things last
 * — because that is the question a reader arrives with: what is this person
 * working on. Within a status group the order is newest-first, which is the
 * only remaining signal.
 *
 * The layout is a list rather than a card grid. The status, the stack and the
 * links are labelled facts, and a bordered box around each project would be
 * four boxes of chrome to hold twelve words.
 */

/**
 * Sort order for the status groups.
 *
 * `null` sorts last: a project with no status has not been classified by its
 * author, and guessing a place for it in the "what is active" ordering would
 * put an unknown in the middle of an answer.
 */
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  maintained: 1,
  experiment: 2,
  archived: 3,
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  maintained: 'Maintained',
  experiment: 'Experiment',
  archived: 'Archived',
}

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Projects',
    description:
      'Things built and maintained — what they are for, what they are built from, and where to find the code.',
    path: '/projects',
  })
}

export default async function ProjectsPage() {
  const [settings, projects] = await Promise.all([
    getSettings(),
    // A hundred is a ceiling rather than a page size: it is far above what a
    // personal site lists here, and it exists so a bad sync cannot render an
    // unbounded page.
    listContent({ type: 'project', limit: 100, sort: 'updated' }),
  ])

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }

  const rank = (item: ContentSummary) =>
    item.projectStatus ? (STATUS_ORDER[item.projectStatus] ?? 4) : 5

  // `Array.prototype.sort` is stable, so everything the status does not separate
  // keeps the query's order — most recently touched first.
  const ordered = [...projects].sort((a, b) => rank(a) - rank(b))

  return (
    <Container>
      <PageHeader
        title="Projects"
        description="Things built and maintained — what they are for, what they are built from, and where to find the code."
        meta={
          projects.length > 0
            ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`
            : undefined
        }
      />

      {ordered.length === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">No projects listed yet.</p>
      ) : (
        <ul className="flex flex-col pt-4">
          {ordered.map((project) => (
            <li key={project.slug} className="border-b border-line py-7 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-lg leading-snug">
                  <Link
                    href={project.url}
                    className="text-ink transition-colors duration-150 hover:text-brand"
                  >
                    {project.title}
                  </Link>
                </h2>

                {project.projectStatus ? (
                  <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
                    {STATUS_LABELS[project.projectStatus] ?? project.projectStatus}
                  </span>
                ) : null}
              </div>

              {project.description ? (
                <p className="mt-2 max-w-[66ch] text-sm leading-relaxed text-ink-muted">
                  {project.description}
                </p>
              ) : null}

              {project.techStack.length > 0 ? (
                <p className="mt-3 text-xs text-ink-subtle">
                  Built with {project.techStack.join(' · ')}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                <time
                  dateTime={project.updatedAt.toISOString()}
                  className="text-xs text-ink-subtle"
                >
                  Updated {formatDate(project.updatedAt, dateContext, 'short')}
                </time>

                {project.tags.length > 0 ? (
                  <TagList tags={project.tags} showHash={false} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Container>
  )
}
