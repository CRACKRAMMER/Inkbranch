import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { Container } from '@/components/site/container'
import { countByType } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

/**
 * About.
 *
 * Assembled from settings rather than from a Markdown file, because everything
 * here is a fact the author changes once a year and should not have to open a
 * text editor to fix. The profile paragraph is stored as plain text and
 * rendered as paragraphs — deliberately not as Markdown, because settings are
 * written from a form and the one input this site renders as HTML is content,
 * which goes through the sanitising pipeline. A second path into the page would
 * be a second thing to get wrong.
 *
 * The page is allowed to be short. An about page padded to fill a screen reads
 * as an obligation; one that says four true things reads as an answer.
 */
export const revalidate = 3600

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
  const [settings, counts] = await Promise.all([getSettings(), countByType()])

  const name = settings.authorName || settings.siteName
  // Blank lines separate paragraphs. `split` on a run of newlines rather than
  // on `\n\n` so that a form textarea saving `\r\n` or three newlines produces
  // the same two paragraphs rather than one with stray breaks in it.
  const paragraphs = settings.aboutProfile
    ? settings.aboutProfile.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
    : []

  const total = counts.post + counts.note + counts.project

  return (
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

          {settings.aboutStack.length > 0 ? (
            <section aria-labelledby="stack" className="mt-12">
              <h3
                id="stack"
                className="mb-4 border-b border-line pb-2 text-xs font-medium uppercase tracking-wider text-ink-subtle"
              >
                Uses
              </h3>
              <dl className="flex flex-col gap-3">
                {settings.aboutStack.map((group) => (
                  <div key={group.group} className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
                    <dt className="text-sm text-ink-subtle">{group.group}</dt>
                    <dd className="text-sm text-ink-muted">{group.items.join(', ')}</dd>
                  </div>
                ))}
              </dl>
            </section>
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
