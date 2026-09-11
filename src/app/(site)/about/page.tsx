import type { Metadata } from 'next'
import Link from 'next/link'

import { EntryList, type Entry } from '@/components/content/entry-list'
import { PageHeader } from '@/components/content/page-header'
import { Section } from '@/components/content/section'
import { Container } from '@/components/site/container'
import { siteOrigin } from '@/env'
import { TYPE_LABELS } from '@/lib/content/labels'
import { countByType, listRecentlyUpdated, type ContentSummary } from '@/lib/content/queries'
import { JsonLd, buildPersonJsonLd } from '@/lib/seo/jsonld'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate } from '@/lib/utils/date'

/**
 * About.
 *
 * Not a résumé. Seven blocks — profile, focus, what the author is doing now,
 * the tools they use, what they maintain, where to find them, and what they
 * wrote last — and no dates of employment, because a CV answers a question
 * nobody reading a blog is asking.
 *
 * The blocks that say something about the author are assembled from settings
 * rather than from a Markdown file, because each is a fact they change once a
 * year and should not have to open a text editor to fix. The profile paragraph
 * is stored as plain text and rendered as paragraphs — deliberately not as
 * Markdown, because settings are written from a form and the one input this
 * site renders as HTML is content, which goes through the sanitising pipeline.
 * A second path into the page would be a second thing to get wrong.
 *
 * The last two blocks are not settings at all. Projects and Latest writing are
 * read from the content index, so an about page written a year ago still points
 * at what the author is actually doing — which is the one thing an about page
 * cannot get from a paragraph. Both come from a single `listRecentlyUpdated`
 * split in memory: they are one question ("what changed lately?") with two
 * answers, and two queries would ask it twice, cost a second round trip, and
 * allow the two lists to disagree about which documents are the newest.
 *
 * The page is allowed to be short. An about page padded to fill a screen reads
 * as an obligation; one that says four true things reads as an answer.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'About',
    description:
      settings.siteDescription || `About ${settings.authorName || settings.siteName}.`,
    path: '/about',
  })
}

export default async function AboutPage() {
  const [settings, counts, updated] = await Promise.all([
    getSettings(),
    countByType(),
    listRecentlyUpdated(12),
  ])

  const name = settings.authorName || settings.siteName

  /*
   * The author as a node rather than as a name repeated on every article. This
   * is the page the `@id` points at, so it is published on the same condition
   * the reference is: no author name, no Person — a site whose owner has not
   * filled the field has no author to describe, and `settings.siteName` is not
   * a person's name.
   *
   * `sameAs` is the contact list filtered down to the profiles that identify
   * the author elsewhere. `mailto:` reaches them but identifies nobody, and a
   * link back to this site says the author is this site, which is the one
   * claim an about page should not need structured data to make.
   */
  const authorProfiles = settings.aboutContact
    .map((entry) => entry.href)
    .filter((href) => /^https?:\/\//i.test(href) && new URL(href).origin !== siteOrigin)

  // Blank lines separate paragraphs. `split` on a run of newlines rather than
  // on `\n\n` so that a form textarea saving `\r\n` or three newlines produces
  // the same two paragraphs rather than one with stray breaks in it.
  const paragraphs = settings.aboutProfile
    ? settings.aboutProfile.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
    : []

  const total = counts.post + counts.note + counts.project

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }

  /*
   * Twelve rows are fetched to fill two lists of at most four and five. The
   * slack is the point: the newest twelve documents are rarely the four
   * projects and the five pieces of writing the page wants, and a limit equal
   * to the visible count would let one busy month of notes crowd every project
   * off the page.
   */
  const projects = updated.filter((item) => item.type === 'project').slice(0, 4)
  const writing = updated.filter((item) => item.type !== 'project').slice(0, 5)
  const spansTypes = new Set(writing.map((item) => item.type)).size > 1

  const toEntry = (item: ContentSummary): Entry => ({
    href: item.url,
    title: item.title,
    dateLabel: formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short'),
    dateTime: toIsoDate(item.publishedAt ?? item.updatedAt),
    readingTime: item.readingTime,
    typeLabel: spansTypes ? TYPE_LABELS[item.type] : undefined,
  })

  return (
    <>
      {settings.authorName ? (
        <JsonLd
          data={buildPersonJsonLd({
            name: settings.authorName,
            url: '/about',
            image: settings.avatarUrl,
            // The tagline rather than the profile: this is the one-line answer
            // to "who is this", and the profile is a page of prose that a
            // consumer would only truncate.
            description: settings.tagline,
            sameAs: authorProfiles,
          })}
        />
      ) : null}

      <Container>
        <PageHeader title="About" description={settings.tagline || null} />

        <div className="grid gap-x-14 gap-y-12 pt-10 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <div>
            <h2 className="text-xl tracking-tight text-ink">{name}</h2>

            {paragraphs.length > 0 ? (
              <div className="mt-5 flex flex-col gap-4">
                {paragraphs.map((paragraph, index) => (
                  <p
                    // Paragraphs are static text in a fixed order and never
                    // reorder, so the index is a stable identity here.
                    key={index}
                    className="max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink-muted"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-5 max-w-[68ch] text-sm leading-relaxed text-ink-subtle">
                This site has no profile written yet. Set one in Settings →
                About.
              </p>
            )}

            {/*
              The three main-column blocks are `h3`: they are parts of the
              author's answer, which is the `h2` above them. The aside is a
              different register — separate, parallel blocks rather than
              sub-headings — and keeps its `h2`.
            */}
            {settings.aboutStack.length > 0 ? (
              <Section as="h3" id="stack" title="Uses">
                <dl className="flex flex-col gap-3">
                  {settings.aboutStack.map((group) => (
                    <div key={group.group} className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
                      <dt className="text-sm text-ink-subtle">{group.group}</dt>
                      <dd className="text-sm text-ink-muted">{group.items.join(', ')}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            {projects.length > 0 ? (
              <Section as="h3" id="projects" title="Projects" href="/projects" linkLabel="All projects">
                <ul className="flex flex-col gap-5">
                  {projects.map((project) => (
                    <li key={project.slug}>
                      <div className="flex items-baseline justify-between gap-4">
                        <Link
                          href={project.url}
                          className="text-base leading-snug text-ink transition-colors duration-150 hover:text-brand"
                        >
                          {project.title}
                        </Link>
                        {project.projectStatus ? (
                          <span className="shrink-0 font-mono text-xs text-ink-subtle">
                            {project.projectStatus}
                          </span>
                        ) : null}
                      </div>
                      {project.description ? (
                        <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-ink-muted">
                          {project.description}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {writing.length > 0 ? (
              <Section
                as="h3"
                id="writing"
                title="Latest writing"
                href="/archive"
                linkLabel="Archive"
              >
                {/*
                  No descriptions, and no tags. This is the page's footer, not
                  another index — the point is that there is recent writing and
                  where it goes, and five titled dates say both.
                */}
                <EntryList entries={writing.map(toEntry)} />
              </Section>
            ) : null}
          </div>

          <aside className="flex flex-col gap-8 lg:border-l lg:border-line lg:pl-8">
            {settings.aboutCurrently.length > 0 ? (
              <section aria-labelledby="now">
                <h2
                  id="now"
                  className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle"
                >
                  Now
                </h2>
                <dl className="flex flex-col gap-2.5">
                  {settings.aboutCurrently.map((entry) => (
                    <div key={entry.label}>
                      <dt className="text-xs text-ink-subtle">{entry.label}</dt>
                      <dd className="text-sm text-ink-muted">{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {settings.aboutFocus.length > 0 ? (
              <section aria-labelledby="focus">
                <h2
                  id="focus"
                  className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle"
                >
                  Focus
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {settings.aboutFocus.map((item) => (
                    <li key={item} className="text-sm text-ink-muted">
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {settings.aboutContact.length > 0 ? (
              <section aria-labelledby="contact">
                <h2
                  id="contact"
                  className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle"
                >
                  Elsewhere
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {settings.aboutContact.map((entry) => (
                    <li key={entry.label}>
                      <a
                        href={entry.href}
                        // A contact link may be `mailto:` as well as `http:`, and
                        // the external-link attributes only make sense on the
                        // latter — `noreferrer` on a mailto is harmless but
                        // `target="_blank"` on one is not, since it can leave an
                        // empty tab behind.
                        {...(entry.href.startsWith('http')
                          ? { target: '_blank', rel: 'noopener noreferrer' }
                          : {})}
                        className="text-sm text-ink-muted underline-offset-4 transition-colors duration-150 hover:text-brand hover:underline"
                      >
                        {entry.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {total > 0 ? (
              <section aria-labelledby="numbers">
                <h2
                  id="numbers"
                  className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-subtle"
                >
                  Here
                </h2>
                <dl className="flex flex-col gap-1.5 text-sm">
                  <Count label="Articles" value={counts.post} href="/posts" />
                  <Count label="Notes" value={counts.note} href="/notes" />
                  <Count label="Projects" value={counts.project} href="/projects" />
                </dl>
                <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
                  <Link href="/archive" className="transition-colors duration-150 hover:text-ink">
                    The full archive →
                  </Link>
                </p>
              </section>
            ) : null}
          </aside>
        </div>
      </Container>
    </>
  )
}

function Count({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt>
        <Link href={href} className="text-ink-muted transition-colors duration-150 hover:text-ink">
          {label}
        </Link>
      </dt>
      <dd className="font-mono text-xs text-ink-subtle tabular-nums">{value}</dd>
    </div>
  )
}
