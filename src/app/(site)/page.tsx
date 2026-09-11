import Link from 'next/link'

import { EntryList, type Entry } from '@/components/content/entry-list'
import { Section } from '@/components/content/section'
import { TagDot } from '@/components/content/tag-dot'
import { TagList } from '@/components/content/tag-list'
import {
  countByType,
  listContent,
  listFeatured,
  listRecentlyUpdated,
  listTags,
  type ContentSummary,
} from '@/lib/content/queries'
import { JsonLd, buildWebsiteJsonLd } from '@/lib/seo/jsonld'
import { siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative, toIsoDate, yearIn } from '@/lib/utils/date'

/**
 * The home page, as a personal dashboard.
 *
 * Deliberately not the avatar → one-line bio → list that every personal site
 * has. The first screen answers "what is this place and what is happening in
 * it" side by side: identity on the left, live state on the right. Below that,
 * the writing itself, in the order a returning reader wants it — what the
 * author chose (Featured), what is new (Recent Writing), what it is about
 * (Explore), and what is being maintained (Digital Garden).
 *
 * On the "no cards" rule: the right-hand column is separated by hairlines, not
 * borders around boxes. A grid of four bordered boxes on the landing page is
 * exactly the template look the brief rules out, and it costs the reader
 * nothing here — the labels already say what each block is.
 *
 * Every date is formatted here, on the server, and passed down as a string.
 * Formatting time zone comes from settings, so a post published late in the
 * evening in the author's zone is dated the day they wrote it rather than
 * shifting back a day on a server running in UTC.
 */
export default async function HomePage() {
  const settings = await getSettings()

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }
  const now = new Date()

  const [featured, recent, updated, tags, counts] = await Promise.all([
    listFeatured(3),
    listContent({ limit: 6 }),
    listRecentlyUpdated(8),
    listTags(),
    countByType(),
  ])

  const toEntry = (item: ContentSummary): Entry => ({
    href: item.url,
    title: item.title,
    dateLabel: formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short'),
    dateTime: toIsoDate(item.publishedAt ?? item.updatedAt),
    description: item.description,
    readingTime: item.readingTime,
    tags: item.tags,
  })

  /*
   * The timeline is grouped by year. A flat list loses the one piece of
   * structure that makes an archive legible — how the writing is distributed
   * over time — and the year is the only heading that carries it.
   */
  const byYear = new Map<string, Entry[]>()
  for (const item of recent) {
    const year = yearIn(item.publishedAt ?? item.updatedAt, settings.timezone)
    const list = byYear.get(year)
    if (list) list.push(toEntry(item))
    else byYear.set(year, [toEntry(item)])
  }

  const projects = updated.filter((item) => item.type === 'project').slice(0, 4)
  const garden = updated.filter((item) => item.type === 'note').slice(0, 6)

  /*
   * Activity, derived rather than stored.
   *
   * There is no events table and there should not be one: an event is a fact
   * about a row, and `content_index` already carries both the publication date
   * and the last-modified date. A row counts as an update only when the edit
   * is meaningfully after publication — the day of slack absorbs the round trip
   * where publishing and saving a fix happen minutes apart.
   */
  const activity = updated
    .map((item) => {
      const edited =
        item.publishedAt !== null &&
        item.updatedAt.getTime() - item.publishedAt.getTime() > 24 * 60 * 60 * 1000

      return {
        key: `${item.type}:${item.slug}`,
        href: item.url,
        title: item.title,
        verb: edited ? 'Updated' : 'Published',
        when: formatRelative(item.updatedAt, { ...dateContext, now }),
        at: item.updatedAt.getTime(),
      }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)

  const topics = tags.slice(0, 8)
  const focus = settings.aboutFocus.slice(0, 6)
  const exploring = settings.aboutCurrently.slice(0, 3)

  return (
    <>
      {/*
        The site itself, once, on the page that is the site. `WebSite` is what
        lets a consumer say "this site is called X and its search lives at Y" —
        the sitelinks search box Google renders for a site it knows, which is
        the one structured-data feature that changes what a reader sees in a
        results page. The search endpoint is only named while the site actually
        has one: `searchEnabled` off makes `/search` a notice rather than a
        search, and a `SearchAction` pointing at that is a promise the site does
        not keep.
      */}
      <JsonLd
        data={buildWebsiteJsonLd({
          site: siteIdentityFromSettings(settings),
          url: '/',
          searchUrl: settings.searchEnabled ? '/search' : null,
        })}
      />

      <div className="mx-auto w-full max-w-[76rem] px-5">
        {/* ---------------------------------------------------------------- */}
        {/*  First screen                                                     */}
        {/* ---------------------------------------------------------------- */}

        <div className="grid gap-x-12 gap-y-10 pb-14 pt-14 md:grid-cols-[1fr_20rem] md:pt-20 lg:grid-cols-[1fr_22rem]">
          <div>
            <h1 className="text-3xl tracking-tight text-ink sm:text-4xl">
              {settings.authorName || settings.siteName}
            </h1>

            {settings.tagline || settings.siteDescription ? (
              <p className="mt-4 max-w-[46ch] text-lg leading-relaxed text-ink-muted">
                {settings.tagline || settings.siteDescription}
              </p>
            ) : null}

            {/*
              The profile paragraph is optional and stays short on the home page.
              The full version belongs on /about; duplicating it here would bury
              the dashboard below a wall of prose.
            */}
            {settings.aboutProfile ? (
              <p className="mt-6 max-w-[52ch] text-sm leading-relaxed text-ink-muted">
                {settings.aboutProfile}
              </p>
            ) : null}

            {focus.length > 0 ? (
              <ul className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-subtle">
                {focus.map((item, index) => (
                  <li key={item} className="flex items-center gap-3">
                    {index > 0 ? (
                      <span aria-hidden="true" className="text-line-strong">
                        ·
                      </span>
                    ) : null}
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <Stat label="Articles" value={counts.post} href="/posts" />
              <Stat label="Notes" value={counts.note} href="/notes" />
              <Stat label="Projects" value={counts.project} href="/projects" />
            </dl>

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <Link href="/about" className="link-underline text-ink-muted hover:text-ink">
                About
              </Link>
              {settings.rssEnabled ? (
                <a href="/rss.xml" className="link-underline text-ink-muted hover:text-ink">
                  RSS
                </a>
              ) : null}
              {settings.searchEnabled ? (
                <Link href="/search" className="link-underline text-ink-muted hover:text-ink">
                  Search
                </Link>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col md:border-l md:border-line md:pl-8">
            {exploring.length > 0 ? (
              <DashboardBlock title="Now">
                <ul className="flex flex-col gap-2">
                  {exploring.map((item) => (
                    <li key={item.label} className="text-sm">
                      <span className="text-ink-subtle">{item.label}</span>
                      <span className="mx-2 text-line-strong" aria-hidden="true">
                        —
                      </span>
                      <span className="text-ink-muted">{item.value}</span>
                    </li>
                  ))}
                </ul>
              </DashboardBlock>
            ) : null}

            <DashboardBlock title="Latest" href="/posts">
              <ul className="flex flex-col gap-2.5">
                {recent.slice(0, 3).map((item) => (
                  <li key={`${item.type}:${item.slug}`}>
                    <Link
                      href={item.url}
                      className="text-sm leading-snug text-ink-muted transition-colors duration-150 hover:text-ink"
                    >
                      {item.title}
                    </Link>
                    <span className="ml-2 whitespace-nowrap text-xs text-ink-subtle">
                      {formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'short')}
                    </span>
                  </li>
                ))}
                {recent.length === 0 ? <EmptyLine>Nothing published yet.</EmptyLine> : null}
              </ul>
            </DashboardBlock>

            <DashboardBlock title="Projects" href="/projects">
              <ul className="flex flex-col gap-2.5">
                {projects.map((item) => (
                  <li key={item.slug} className="flex items-baseline justify-between gap-3">
                    <Link
                      href={item.url}
                      className="truncate text-sm text-ink-muted transition-colors duration-150 hover:text-ink"
                    >
                      {item.title}
                    </Link>
                    {item.projectStatus ? (
                      <span className="shrink-0 text-xs text-ink-subtle">{item.projectStatus}</span>
                    ) : null}
                  </li>
                ))}
                {projects.length === 0 ? <EmptyLine>Nothing here yet.</EmptyLine> : null}
              </ul>
            </DashboardBlock>

            <DashboardBlock title="Activity">
              <ul className="flex flex-col gap-2.5">
                {activity.map((event) => (
                  <li key={event.key} className="text-xs leading-relaxed">
                    <span className="text-ink-subtle">{event.verb}</span>{' '}
                    <Link
                      href={event.href}
                      className="text-ink-muted transition-colors duration-150 hover:text-ink"
                    >
                      {event.title}
                    </Link>
                    <span className="ml-1.5 text-ink-subtle">{event.when}</span>
                  </li>
                ))}
                {activity.length === 0 ? <EmptyLine>No activity yet.</EmptyLine> : null}
              </ul>
            </DashboardBlock>
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/*  Featured                                                         */}
        {/* ---------------------------------------------------------------- */}

        {featured.length > 0 ? (
          <Section title="Featured" id="featured">
            <ul className="grid gap-px overflow-hidden bg-line sm:grid-cols-2">
              {featured.map((item, index) => (
                <li
                  key={`${item.type}:${item.slug}`}
                  // The first featured item spans the full width, so the choice
                  // reads as ranked rather than as an arbitrary first cell.
                  className={index === 0 ? 'bg-canvas sm:col-span-2' : 'bg-canvas'}
                >
                  <Link href={item.url} className="group flex h-full flex-col p-6 sm:p-7">
                    <div className="flex items-center gap-2.5 text-xs text-ink-subtle">
                      <time dateTime={toIsoDate(item.publishedAt ?? item.updatedAt)}>
                        {formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'medium')}
                      </time>
                      <span aria-hidden="true">·</span>
                      <span>{item.readingTime} min</span>
                    </div>

                    <h3
                      className={
                        index === 0
                          ? 'mt-3 text-2xl leading-snug tracking-tight text-ink transition-colors duration-150 group-hover:text-brand'
                          : 'mt-3 text-lg leading-snug tracking-tight text-ink transition-colors duration-150 group-hover:text-brand'
                      }
                    >
                      {item.title}
                    </h3>

                    {item.description ? (
                      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-muted">
                        {item.description}
                      </p>
                    ) : null}

                    {item.tags.length > 0 ? (
                      <TagList tags={item.tags} className="mt-5" />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/*  Recent writing                                                   */}
        {/* ---------------------------------------------------------------- */}

        <Section title="Recent Writing" href="/posts" linkLabel="All writing" id="recent">
          {recent.length === 0 ? (
            <p className="py-6 text-sm text-ink-subtle">
              Nothing published yet. Once a post is published it appears here.
            </p>
          ) : (
            <div className="flex flex-col gap-8">
              {[...byYear.entries()].map(([year, entries]) => (
                <div key={year}>
                  <h3 className="mb-1 font-mono text-xs text-ink-subtle">{year}</h3>
                  {/*
                    No descriptions here. The brief asks for this list to be kept
                    very clean, and six date-title pairs scan as a timeline where
                    six date-title-paragraph triples scan as a list of cards.
                  */}
                  <EntryList entries={entries} />
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/*  Explore                                                          */}
        {/* ---------------------------------------------------------------- */}

        {topics.length > 0 ? (
          <Section title="Explore" href="/tags" linkLabel="All topics" id="explore">
            <ul className="grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
              {topics.map((topic) => (
                <li key={topic.slug} className="bg-canvas">
                  <Link
                    href={`/tags/${encodeURIComponent(topic.slug)}`}
                    className="group flex items-baseline justify-between gap-3 px-4 py-3.5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <TagDot slug={topic.slug} color={topic.color} />
                      <span className="truncate text-sm text-ink-muted transition-colors duration-150 group-hover:text-ink">
                        {topic.name}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-ink-subtle">{topic.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/*  Digital garden                                                   */}
        {/* ---------------------------------------------------------------- */}

        {garden.length > 0 ? (
          <Section title="Digital Garden" href="/notes" linkLabel="All notes" id="garden">
            <p className="-mt-2 mb-5 max-w-[62ch] text-sm leading-relaxed text-ink-muted">
              Notes are tended rather than published. These are the ones most recently
              revised — dated by when they last changed, not when they were planted.
            </p>
            <ul className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
              {garden.map((note) => (
                <li key={note.slug} className="border-l border-line pl-4">
                  <div className="flex items-baseline gap-2.5 text-xs">
                    <span className="text-brand">
                      Updated {formatRelative(note.updatedAt, { ...dateContext, now })}
                    </span>
                    {note.publishedAt ? (
                      <span className="text-ink-subtle">
                        planted {formatDate(note.publishedAt, dateContext, 'short')}
                      </span>
                    ) : null}
                  </div>
                  <Link
                    href={note.url}
                    className="mt-1.5 block text-base leading-snug text-ink transition-colors duration-150 hover:text-brand"
                  >
                    {note.title}
                  </Link>
                  {note.description ? (
                    <p className="mt-1.5 max-w-[54ch] text-sm leading-relaxed text-ink-muted">
                      {note.description}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Local pieces                                                               */
/* -------------------------------------------------------------------------- */

/** A count with its label, as a definition pair. */
function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="sr-only">{label}</dt>
      <dd>
        <Link href={href} className="group flex items-baseline gap-2">
          <span className="font-mono text-base text-ink tabular-nums">{value}</span>
          <span className="text-xs text-ink-subtle transition-colors duration-150 group-hover:text-ink-muted">
            {label}
          </span>
        </Link>
      </dd>
    </div>
  )
}

/** One block of the dashboard column, separated by a hairline above. */
function DashboardBlock({
  title,
  href,
  children,
}: {
  title: string
  href?: string
  children: React.ReactNode
}) {
  return (
    <div className="border-t border-line py-5 first:border-t-0 first:pt-0 md:first:border-t md:first:pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">{title}</h2>
        {href ? (
          <Link
            href={href}
            className="text-xs text-ink-subtle transition-colors duration-150 hover:text-brand"
          >
            All
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <li className="text-xs text-ink-subtle">{children}</li>
}
