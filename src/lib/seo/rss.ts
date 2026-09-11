import {
  absoluteUrl,
  documentCanonicalUrl,
  effectivePublishedAt,
  isPublic,
  resolveDescription,
  tagNames,
  type SeoDocument,
  type SiteIdentity,
} from './metadata'

/**
 * Feeds.
 *
 * RSS 2.0 is the primary format — every reader still in use parses it, and it
 * is what `/rss.xml` is expected to be. Atom is built from the same items
 * because two feeds from one list cannot disagree.
 *
 * Text is escaped, never wrapped in CDATA. CDATA only protects the characters
 * it encloses, and only until the text contains `]]>` — which is exactly the
 * input an author writing about XML will produce. Escaping every text node has
 * no such exception.
 */

/** Default item count, matching `site_settings.rss_item_limit`. */
const DEFAULT_LIMIT = 30

/**
 * Hard ceiling on feed size. A feed is fetched in full, by readers and by
 * crawlers, and an unbounded one grows with the archive until a subscriber's
 * first sync is a megabyte.
 */
const MAX_LIMIT = 100

/*
 * C0 controls other than tab, newline and carriage return are not legal in XML
 * 1.0 at all — not even escaped. A stray one makes the whole document
 * unparseable, so the feed is served empty to every reader rather than clipped.
 * This is one of the few places matching control characters is correct.
 */
/* eslint-disable-next-line no-control-regex */
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

/**
 * Lone surrogates, which are also illegal in XML.
 *
 * A pair is a character and must survive, so this cannot be a plain character
 * class — matching one half of a pair would strip every emoji in the archive.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Escape a value for use in XML text or a double-quoted attribute. */
export function escapeXml(input: string): string {
  return input
    .replace(ILLEGAL_XML, '')
    .replace(LONE_SURROGATE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

export interface FeedOptions {
  site: SiteIdentity
  /** Candidate documents; filtered, sorted and cut here. */
  documents: readonly SeoDocument[]
  /** Absolute URL the feed is served from, e.g. `https://example.com/rss.xml`. */
  selfUrl: string
  /** Feed title. Defaults to the site name; a tag feed passes its own. */
  title?: string
  description?: string
  /** Items to emit. Defaults to 30, capped at 100. */
  limit?: number
  /** Injected by tests; nothing else should need to pass one. */
  now?: Date
}

/**
 * The items a feed carries: live, not opted out, newest first.
 *
 * The date is the one `isPublic` accepts the document on, so an item is never
 * in the feed without a date to attach to it. Ties are broken by slug so the
 * same content always produces byte-identical output: a feed whose item order
 * wobbles between requests looks changed to every reader that compares them.
 */
export function feedItems(
  options: FeedOptions,
): { doc: SeoDocument; publishedAt: Date }[] {
  const now = options.now ?? new Date()
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT)

  return options.documents
    .flatMap((doc) => {
      if (!isPublic(doc, now)) return []
      const publishedAt = effectivePublishedAt(doc)
      return publishedAt ? [{ doc, publishedAt }] : []
    })
    .sort((a, b) => {
      const byDate = b.publishedAt.getTime() - a.publishedAt.getTime()
      return byDate !== 0 ? byDate : a.doc.slug.localeCompare(b.doc.slug)
    })
    .slice(0, limit)
}

/* -------------------------------------------------------------------------- */
/*  RSS 2.0                                                                    */
/* -------------------------------------------------------------------------- */

/** RFC 822 date, which is what RSS 2.0 requires for `pubDate`. */
export function rfc822(date: Date): string {
  return date.toUTCString()
}

function rssItem(
  entry: { doc: SeoDocument; publishedAt: Date },
  site: SiteIdentity,
): string {
  const { doc } = entry
  const url = documentCanonicalUrl(doc)
  const description = resolveDescription(doc, site)

  const lines = [
    '    <item>',
    `      <title>${escapeXml(doc.title)}</title>`,
    `      <link>${escapeXml(url)}</link>`,
    // Permanent and the URL itself, so the guid stays stable across a title
    // edit — a changed guid re-shows every item in a reader as unread.
    `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
    `      <pubDate>${escapeXml(rfc822(entry.publishedAt))}</pubDate>`,
    `      <description>${escapeXml(description)}</description>`,
  ]

  for (const tag of tagNames(doc.tags)) {
    lines.push(`      <category>${escapeXml(tag)}</category>`)
  }

  if (site.authorName) {
    // `dc:creator` rather than RSS's own `<author>`, which is defined as an
    // email address; putting a name there is the common non-conformance.
    lines.push(`      <dc:creator>${escapeXml(site.authorName)}</dc:creator>`)
  }

  if (doc.cover) {
    // A dynamic card has no size until it is rendered, and RSS requires the
    // attribute; zero is the documented way to say "not known".
    lines.push(
      `      <enclosure url="${escapeXml(absoluteUrl(doc.cover))}" type="image/webp" length="0"/>`,
    )
  }

  lines.push('    </item>')
  return lines.join('\n')
}

/**
 * RSS 2.0.
 *
 * `lastBuildDate` is the newest item's date, never the moment of the request.
 * A feed that reports a new build time every time it is fetched tells readers
 * it changed when it did not, and a reader that learns that stops fetching.
 * With no items there is no honest date to report, so the element is left out.
 */
export function buildRssFeed(options: FeedOptions): string {
  const { site } = options
  const items = feedItems(options)
  const title = options.title ?? site.name
  const description = options.description ?? site.description ?? ''
  const home = absoluteUrl('/')
  const selfUrl = absoluteUrl(options.selfUrl)
  const newest = items[0]?.publishedAt

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(home)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    site.locale ? `    <language>${escapeXml(site.locale)}</language>` : '',
    newest ? `    <lastBuildDate>${escapeXml(rfc822(newest))}</lastBuildDate>` : '',
    // Self-referencing, so an aggregator that was handed the feed by a proxy
    // still knows where it really lives.
    `    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`,
  ].filter(Boolean)

  const body = items.map((item) => rssItem(item, site))

  return [...head, ...body, '  </channel>', '</rss>', ''].join('\n')
}

/* -------------------------------------------------------------------------- */
/*  Atom                                                                       */
/* -------------------------------------------------------------------------- */

function atomEntry(
  entry: { doc: SeoDocument; publishedAt: Date },
  site: SiteIdentity,
): string {
  const { doc } = entry
  const url = documentCanonicalUrl(doc)
  const updated = doc.updatedAt ?? entry.publishedAt
  const description = resolveDescription(doc, site)

  const lines = [
    /*
     * `xml:lang` only when the entry disagrees with the feed. Atom resolves the
     * language from the nearest ancestor that declares one, so the feed's own
     * declaration covers every entry written in the site's language, and this
     * attribute is exactly the exception. Repeating it on every entry would be
     * noise that hides the one entry where it carries information.
     *
     * RSS 2.0, below, gets nothing: `<language>` is defined at channel level
     * only, and there is no conformant per-item equivalent to reach for.
     */
    doc.lang && doc.lang !== site.locale
      ? `  <entry xml:lang="${escapeXml(doc.lang)}">`
      : '  <entry>',
    `    <title>${escapeXml(doc.title)}</title>`,
    `    <link href="${escapeXml(url)}" rel="alternate" type="text/html"/>`,
    // Atom requires an IRI id and requires it to be permanent. The canonical
    // URL is both; a `tag:` URI would survive a domain move, which this site
    // has no plan for.
    `    <id>${escapeXml(url)}</id>`,
    `    <published>${escapeXml(entry.publishedAt.toISOString())}</published>`,
    `    <updated>${escapeXml(updated.toISOString())}</updated>`,
    `    <summary type="text">${escapeXml(description)}</summary>`,
  ]

  if (site.authorName) {
    lines.push('    <author>', `      <name>${escapeXml(site.authorName)}</name>`, '    </author>')
  }

  for (const tag of tagNames(doc.tags)) {
    lines.push(`    <category term="${escapeXml(tag)}"/>`)
  }

  lines.push('  </entry>')
  return lines.join('\n')
}

/**
 * Atom 1.0.
 *
 * `updated` is required on the feed, and it is the newest item's update time.
 * An empty feed has no honest value for it — see `buildRssFeed` on why the
 * generation time is not one — so a feed with no entries leaves it out rather
 * than claiming a change that did not happen.
 */
export function buildAtomFeed(options: FeedOptions): string {
  const { site } = options
  const items = feedItems(options)
  const title = options.title ?? site.name
  const description = options.description ?? site.description ?? ''
  const home = absoluteUrl('/')
  const selfUrl = absoluteUrl(options.selfUrl)
  const newest = items[0]
  const updated = newest ? (newest.doc.updatedAt ?? newest.publishedAt) : undefined

  const head = [
    '<?xml version="1.0" encoding="utf-8"?>',
    // The feed's language, stated once, so an entry written in another one has
    // something to be an exception to.
    site.locale
      ? `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(site.locale)}">`
      : '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(title)}</title>`,
    description ? `  <subtitle>${escapeXml(description)}</subtitle>` : '',
    `  <id>${escapeXml(home)}</id>`,
    `  <link href="${escapeXml(home)}" rel="alternate" type="text/html"/>`,
    `  <link href="${escapeXml(selfUrl)}" rel="self" type="application/atom+xml"/>`,
    updated ? `  <updated>${escapeXml(updated.toISOString())}</updated>` : '',
    site.authorName
      ? `  <author>\n    <name>${escapeXml(site.authorName)}</name>\n  </author>`
      : '',
  ].filter(Boolean)

  const body = items.map((item) => atomEntry(item, site))

  return [...head, ...body, '</feed>', ''].join('\n')
}
