import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { Metadata } from 'next'
import { siteOrigin } from '@/env'
import {
  absoluteUrl,
  buildContentMetadata,
  buildPageMetadata,
  documentCanonicalUrl,
  isPublic,
  MAX_DESCRIPTION_WIDTH,
  resolveSeoFields,
  resolveTitle,
  SITE_ATOM_PATH,
  SITE_RSS_PATH,
  siteIdentityFromSettings,
  truncateDescription,
  type SeoDocument,
  type SiteIdentity,
} from '@/lib/seo/metadata'
import {
  authorNodeId,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildPersonJsonLd,
  buildWebsiteJsonLd,
  JsonLd,
  serializeJsonLd,
} from '@/lib/seo/jsonld'
import {
  buildAtomFeed,
  buildRssFeed,
  escapeXml,
  rfc822,
} from '@/lib/seo/rss'
import {
  buildSitemapEntries,
  STATIC_ROUTES,
} from '@/lib/seo/sitemap'
import { buildRobots } from '@/lib/seo/robots'
import {
  layoutTitle,
  loadOgFont,
  OG_FONT_PATH,
  renderOgImage,
  unitsPerLine,
} from '@/lib/seo/og-image'
import { displayWidth } from '@/lib/utils/text'
import { SETTINGS_DEFAULTS } from '@/lib/settings'

/**
 * These are the parts of SEO where a defect is invisible until it is an
 * incident: an unescaped title that becomes script, a draft that reaches the
 * sitemap, a Chinese description cut through the middle of a character, an
 * admin route that robots.txt invites a crawler into. Every assertion below is
 * about one of those failure modes rather than about the shape of an object.
 */

const site: SiteIdentity = {
  name: 'My Blog',
  description: '技术笔记与写作',
  authorName: 'Xie Chengan',
  locale: 'zh-CN',
  twitterHandle: 'example',
}

function doc(overrides: Partial<SeoDocument> = {}): SeoDocument {
  return {
    type: 'post',
    slug: 'hello-world',
    title: 'Hello World',
    description: 'A first post.',
    status: 'published',
    publishedAt: new Date('2026-01-02T12:00:00.000Z'),
    updatedAt: new Date('2026-02-03T12:00:00.000Z'),
    tags: ['linux'],
    ...overrides,
  }
}

/** Control characters and separators are built, never typed: a raw one in a
 *  source file is invisible and does not survive every editor. */
const NUL = String.fromCharCode(0)
const BACKSPACE = String.fromCharCode(8)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
/** What a broken multi-byte cut leaves behind: U+FFFD. */
const REPLACEMENT = String.fromCharCode(0xfffd)

/** The `og:image` URLs a metadata object carries, however Next represents them. */
function ogImageUrls(metadata: Metadata): string[] {
  const images = metadata.openGraph?.images
  if (!images) return []
  const list = Array.isArray(images) ? images : [images]
  return list.map((image) => {
    if (typeof image === 'string') return image
    if (image instanceof URL) return image.toString()
    return String(image.url)
  })
}

/* -------------------------------------------------------------------------- */
/*  XML escaping                                                               */
/* -------------------------------------------------------------------------- */

describe('escapeXml', () => {
  it('escapes the five characters that are unsafe in XML', () => {
    expect(escapeXml('<a> & "b" \'c\'')).toBe(
      '&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;',
    )
  })

  it('escapes a CDATA terminator rather than wrapping text in CDATA', () => {
    // `]]>` only ends a CDATA section, so escaping it as text is what makes a
    // document about XML safe to syndicate. Wrapping in CDATA would not.
    expect(escapeXml(']]>')).toBe(']]&gt;')
    expect(escapeXml(']]>')).not.toContain(']]>')
  })

  it('escapes ampersands once, not twice', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
    expect(escapeXml('a & b')).toBe('a &amp; b')
  })

  it('drops control characters XML cannot represent, keeping tab and newline', () => {
    expect(escapeXml(`a${NUL}b${BACKSPACE}c`)).toBe('abc')
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc')
  })

  it('drops lone surrogates but keeps a pair', () => {
    expect(escapeXml('a\uD800b')).toBe('ab')
    expect(escapeXml('a\uDC00b')).toBe('ab')
    expect(escapeXml('😀')).toBe('😀')
  })
})

describe('buildRssFeed', () => {
  const base = {
    site,
    selfUrl: '/rss.xml',
    now: new Date('2026-09-11T00:00:00.000Z'),
  }

  it('escapes markup in a title, leaving no unescaped ampersand anywhere', () => {
    const feed = buildRssFeed({
      ...base,
      documents: [doc({ title: 'Cheatsheet <tag> & "quote" ]]> done' })],
    })

    expect(feed).toContain('Cheatsheet &lt;tag&gt; &amp; &quot;quote&quot; ]]&gt; done')
    expect(feed).not.toContain('<![CDATA[')
    // Well-formedness in one line: every `&` in the document must open an
    // entity, because a bare one makes the feed unparseable for every reader.
    expect(feed.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)).toBeNull()
  })

  it('escapes the ampersand in a link rather than emitting it raw', () => {
    // The slug is percent-encoded into the path by `documentUrl` and escaped
    // again for XML; a raw `&` in an attribute is the classic feed bug.
    const feed = buildRssFeed({
      ...base,
      documents: [doc({ slug: 'a&b' })],
    })
    expect(feed).toContain(`${siteOrigin}/posts/a%26b`)
    expect(feed).not.toContain('/posts/a&b')
  })

  it('carries published documents only, newest first', () => {
    const feed = buildRssFeed({
      ...base,
      documents: [
        doc({ slug: 'old', title: 'Old', publishedAt: new Date('2026-01-01T00:00:00Z') }),
        doc({ slug: 'draft', title: 'Draft title', status: 'draft' }),
        doc({ slug: 'archived', title: 'Archived title', status: 'archived' }),
        doc({ slug: 'future', title: 'Future title', publishedAt: new Date('2027-01-01T00:00:00Z') }),
        doc({ slug: 'hidden', title: 'Hidden title', noindex: true }),
        doc({
          slug: 'due',
          title: 'Due title',
          status: 'scheduled',
          publishedAt: null,
          scheduledAt: new Date('2026-03-01T00:00:00Z'),
        }),
        doc({ slug: 'new', title: 'New', publishedAt: new Date('2026-05-01T00:00:00Z') }),
      ],
    })

    expect(feed).toContain('Old')
    expect(feed).toContain('New')
    expect(feed).toContain('Due title')
    expect(feed).not.toContain('Draft title')
    expect(feed).not.toContain('Archived title')
    expect(feed).not.toContain('Future title')
    expect(feed).not.toContain('Hidden title')
    expect(feed.indexOf('New')).toBeLessThan(feed.indexOf('Due title'))
    expect(feed.indexOf('Due title')).toBeLessThan(feed.indexOf('Old'))
    // A scheduled item carries the moment its schedule fires, not the absence
    // of a publication date.
    expect(feed).toContain('<pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate>')
  })

  it('bounds the item count', () => {
    const documents = Array.from({ length: 150 }, (_unused, index) =>
      doc({
        slug: `post-${index}`,
        publishedAt: new Date(2026, 0, 1 + (index % 28)),
      }),
    )

    expect(buildRssFeed({ ...base, documents }).match(/<item>/g)).toHaveLength(30)
    expect(
      buildRssFeed({ ...base, documents, limit: 500 }).match(/<item>/g),
    ).toHaveLength(100)
  })

  it('dates lastBuildDate from the newest document, not from now', () => {
    const documents = [
      doc({ slug: 'a', publishedAt: new Date('2026-03-04T05:06:07.000Z') }),
      doc({ slug: 'b', publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    ]

    const feed = buildRssFeed({ ...base, documents })
    expect(feed).toContain('<lastBuildDate>Wed, 04 Mar 2026 05:06:07 GMT</lastBuildDate>')
    // Two builds with different clocks must produce the same bytes, or readers
    // learn that a changed feed means nothing.
    expect(buildRssFeed({ ...base, documents })).toBe(feed)
  })

  it('omits lastBuildDate when there is no document to derive it from', () => {
    const feed = buildRssFeed({ ...base, documents: [] })
    expect(feed).not.toContain('lastBuildDate')
  })

  it('self-references and links absolutely', () => {
    const feed = buildRssFeed({ ...base, documents: [doc()] })
    expect(feed).toContain(
      `<atom:link href="${siteOrigin}/rss.xml" rel="self" type="application/rss+xml"/>`,
    )
    expect(feed).toContain(`<link>${siteOrigin}/posts/hello-world</link>`)
    expect(feed).toContain(`<guid isPermaLink="true">${siteOrigin}/posts/hello-world</guid>`)
  })

  it('writes RFC 822 dates and attributes the author by name', () => {
    const feed = buildRssFeed({ ...base, documents: [doc()] })
    expect(feed).toContain('<pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate>')
    expect(feed).toContain('<dc:creator>Xie Chengan</dc:creator>')
    // RSS's own <author> is defined as an email address; a name in it is the
    // common non-conformance this avoids.
    expect(feed).not.toContain('<author>')
  })
})

describe('buildAtomFeed', () => {
  const base = {
    site,
    selfUrl: '/atom.xml',
    now: new Date('2026-09-11T00:00:00.000Z'),
  }

  it('writes RFC 3339 dates from the item update time', () => {
    const feed = buildAtomFeed({ ...base, documents: [doc()] })
    expect(feed).toContain('<published>2026-01-02T12:00:00.000Z</published>')
    expect(feed).toContain('<updated>2026-02-03T12:00:00.000Z</updated>')
    expect(feed).toContain(
      `<link href="${siteOrigin}/atom.xml" rel="self" type="application/atom+xml"/>`,
    )
  })

  it('omits the feed updated time when no document can date it', () => {
    expect(buildAtomFeed({ ...base, documents: [] })).not.toContain('<updated>')
  })

  it('declares the feed language once and marks only the entries that differ', () => {
    // The feed is `zh-CN`. A note written in English is the exception and says
    // so on the entry, which is the element Atom resolves the language from.
    const feed = buildAtomFeed({
      ...base,
      documents: [doc({ slug: 'zh', lang: 'zh-CN' }), doc({ slug: 'en', lang: 'en' })],
    })

    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-CN">')
    expect(feed).toContain('<entry xml:lang="en">')
    // Not repeated on the entry that agrees: the attribute is information only
    // where it disagrees, and a copy on every entry would hide the one that
    // carries it.
    expect(feed.match(/<entry xml:lang=/g)).toHaveLength(1)
    expect(feed.match(/<entry>/g)).toHaveLength(1)
  })

  it('claims no feed language when the site has none', () => {
    const feed = buildAtomFeed({
      ...base,
      site: { name: 'My Blog' },
      documents: [doc({ lang: 'zh-CN' })],
    })

    // Nothing above the entry declares a language, so the feed states none —
    // but the entry still knows its own, and an entry that knows is not
    // redundant. The only thing withheld is a claim the site cannot make.
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(feed).toContain('<entry xml:lang="zh-CN">')
  })
})

/* -------------------------------------------------------------------------- */
/*  JSON-LD escaping                                                           */
/* -------------------------------------------------------------------------- */

interface ScriptElementProps {
  dangerouslySetInnerHTML: { __html: string }
}

describe('serializeJsonLd', () => {
  const breakout = '</script><script>alert(1)</script>'

  it('cannot be broken out of by a title that closes the script element', () => {
    const data = buildArticleJsonLd({ site, doc: doc({ title: breakout }) })
    const html = serializeJsonLd(data)

    expect(html).not.toContain('</script')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<!--')
    // Escaped, not redacted: the title has to survive the round trip or the
    // structured data stops describing the page it is on.
    expect(JSON.parse(html).headline).toBe(breakout)
  })

  it('escapes the separators a JSON string may contain but a script may not', () => {
    const html = serializeJsonLd({ headline: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` })
    expect(html).toContain('\\u2028')
    expect(html).toContain('\\u2029')
    expect(html).not.toContain(LINE_SEPARATOR)
    expect(JSON.parse(html).headline).toBe(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)
  })

  it('escapes markup inside array values too', () => {
    const html = serializeJsonLd({ keywords: ['<img src=x onerror=alert(1)>'] })
    expect(html).not.toContain('<img')
    expect(JSON.parse(html).keywords[0]).toBe('<img src=x onerror=alert(1)>')
  })

  it('renders the escaped text into the script element', () => {
    const data = buildArticleJsonLd({ site, doc: doc({ title: breakout }) })
    const element = JsonLd({ data }) as ReactElement<ScriptElementProps>
    const html = element.props.dangerouslySetInnerHTML.__html

    expect(html).not.toContain('</script')
    expect(element.type).toBe('script')
  })
})

describe('buildArticleJsonLd', () => {
  it('selects a type per content type', () => {
    const type = (document: SeoDocument): unknown =>
      buildArticleJsonLd({ site, doc: document })['@type']

    expect(type(doc({ type: 'post' }))).toBe('BlogPosting')
    expect(type(doc({ type: 'note' }))).toBe('TechArticle')
    expect(type(doc({ type: 'project' }))).toBe('CreativeWork')
    expect(type(doc({ type: 'project', repoUrl: 'https://github.com/x/y' }))).toBe(
      'SoftwareSourceCode',
    )
  })

  it('omits fields it has no value for', () => {
    const data = buildArticleJsonLd({
      site: { name: 'My Blog' },
      doc: doc({ publishedAt: null, tags: [], description: null, body: null }),
    })

    expect(data).not.toHaveProperty('image')
    expect(data).not.toHaveProperty('keywords')
    expect(data).not.toHaveProperty('datePublished')
    // Dates are dropped, not nulled: `"datePublished": null` claims a field
    // exists and gives a consumer nothing.
    expect(Object.values(data)).not.toContain(null)
  })

  it('points at the canonical URL of the document', () => {
    const data = buildArticleJsonLd({ site, doc: doc({ type: 'note', slug: 'cjk-笔记' }) })
    const url = `${siteOrigin}/notes/${encodeURIComponent('cjk-笔记')}`
    expect(data.url).toBe(url)
    expect(data.mainEntityOfPage).toEqual({ '@type': 'WebPage', '@id': url })
  })

  it('states the language the document is written in, not the site’s', () => {
    // The site is `zh-CN`. A note written in English is in English, and saying
    // otherwise contradicts the page's own `<article lang>` — a machine-reader
    // would be told the opposite of what a screen reader is told.
    expect(buildArticleJsonLd({ site, doc: doc({ lang: 'en' }) }).inLanguage).toBe('en')
    expect(buildArticleJsonLd({ site, doc: doc({ lang: 'zh-CN' }) }).inLanguage).toBe('zh-CN')
  })

  it('falls back to the site locale when the document has no language', () => {
    // The row a caller built from `content_index` may not have selected one.
    expect(buildArticleJsonLd({ site, doc: doc({ lang: null }) }).inLanguage).toBe('zh-CN')
    expect(buildArticleJsonLd({ site, doc: doc() }).inLanguage).toBe('zh-CN')

    // Neither: the field is dropped, because an empty string is a claim that
    // the document has no language and `null` is a claim that a field exists.
    expect(buildArticleJsonLd({ site: { name: 'My Blog' }, doc: doc() })).not.toHaveProperty(
      'inLanguage',
    )
  })
})

describe('buildWebsiteJsonLd', () => {
  it('describes the site and its search action', () => {
    const data = buildWebsiteJsonLd({ site, searchUrl: '/api/search' })
    expect(data['@type']).toBe('WebSite')
    expect(data.url).toBe(`${siteOrigin}/`)
    expect(data.inLanguage).toBe('zh-CN')
    expect(data.potentialAction).toMatchObject({
      '@type': 'SearchAction',
      'query-input': 'required name=q',
    })
  })

  it('leaves the search action out when there is nothing to point it at', () => {
    expect(buildWebsiteJsonLd({ site })).not.toHaveProperty('potentialAction')
  })
})

describe('buildBreadcrumbJsonLd and buildPersonJsonLd', () => {
  it('numbers breadcrumb items from one', () => {
    const data = buildBreadcrumbJsonLd([
      { name: 'Home', url: '/' },
      { name: 'Posts', url: '/posts' },
      { name: 'Hello World' },
    ])

    expect(data.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteOrigin}/` },
      { '@type': 'ListItem', position: 2, name: 'Posts', item: `${siteOrigin}/posts` },
      { '@type': 'ListItem', position: 3, name: 'Hello World' },
    ])
  })

  it('absolutises profile URLs', () => {
    const data = buildPersonJsonLd({
      name: 'Xie Chengan',
      url: '/about',
      sameAs: ['https://github.com/example'],
    })
    expect(data.url).toBe(`${siteOrigin}/about`)
    expect(data).not.toHaveProperty('image')
  })
})

/* -------------------------------------------------------------------------- */
/*  The author node                                                            */
/* -------------------------------------------------------------------------- */

describe('authorNodeId', () => {
  it('names the person on the about page', () => {
    expect(authorNodeId('Xie Chengan')).toBe(`${siteOrigin}/about#person`)
  })

  it('has no id to offer when the site has no author name', () => {
    // Not the site name, and not an empty-string id: an article whose author is
    // a `@id` pointing at a node no page defines is worse than one that names
    // nobody, because a consumer that resolves it finds nothing and cannot tell
    // that from a mistake.
    expect(authorNodeId('')).toBeNull()
    expect(authorNodeId('   ')).toBeNull()
    expect(authorNodeId(null)).toBeNull()
    expect(authorNodeId(undefined)).toBeNull()
  })

  it('follows the about page when it moves', () => {
    // The id is derived from the page's URL rather than hard-coded, so a site
    // that relocates its about page relocates the node with it.
    expect(authorNodeId('Xie Chengan', '/me')).toBe(`${siteOrigin}/me#person`)
  })
})

describe('the author reference and the author node', () => {
  it('gives the article and the Person node the same id', () => {
    // The whole point of the shared helper: one entity, two documents. If these
    // two ever disagree the site has two strangers with one name.
    const person = buildPersonJsonLd({ name: 'Xie Chengan', url: '/about' })
    const article = buildArticleJsonLd({
      site,
      doc: doc(),
      authorId: authorNodeId(site.authorName),
    })

    expect(article.author).toMatchObject({
      '@type': 'Person',
      '@id': person['@id'],
      name: 'Xie Chengan',
    })
  })

  it('carries a name alongside the reference, for consumers that do not resolve it', () => {
    const article = buildArticleJsonLd({
      site,
      doc: doc(),
      authorId: authorNodeId(site.authorName),
    })

    expect(article.author).toHaveProperty('name', 'Xie Chengan')
  })

  it('emits no dangling id when the caller has no author node', () => {
    // `authorNodeId` returns null for a site with no author name, and that null
    // travels straight through: the reference and the node are published
    // together or not at all.
    const article = buildArticleJsonLd({ site, doc: doc() })

    expect(article.author).toEqual({ '@type': 'Person', name: 'Xie Chengan' })
    expect(article.author).not.toHaveProperty('@id')
  })
})

/* -------------------------------------------------------------------------- */
/*  URLs and metadata                                                          */
/* -------------------------------------------------------------------------- */

describe('absoluteUrl', () => {
  it('joins a site-relative path to the origin', () => {
    expect(absoluteUrl('/posts/hello')).toBe(`${siteOrigin}/posts/hello`)
    expect(absoluteUrl('posts/hello')).toBe(`${siteOrigin}/posts/hello`)
  })

  it('keeps the query string and the fragment', () => {
    expect(absoluteUrl('/posts/hello?page=2&sort=old#top')).toBe(
      `${siteOrigin}/posts/hello?page=2&sort=old#top`,
    )
  })

  it('preserves a trailing slash the author wrote', () => {
    // A canonical that is silently rewritten is a canonical the author cannot
    // reason about; `/posts/x/` and `/posts/x` are the author's choice.
    expect(absoluteUrl('/posts/hello/')).toBe(`${siteOrigin}/posts/hello/`)
    expect(absoluteUrl('/')).toBe(`${siteOrigin}/`)
  })

  it('collapses repeated slashes rather than emitting them', () => {
    expect(absoluteUrl('//posts//hello')).toBe(`${siteOrigin}/posts/hello`)
  })

  it('never turns a protocol-relative path into another host', () => {
    const url = absoluteUrl('//evil.example.com/steal')
    expect(new URL(url).host).toBe(new URL(siteOrigin).host)
    expect(url.startsWith(`${siteOrigin}/`)).toBe(true)
  })

  it('leaves an already absolute URL alone', () => {
    expect(absoluteUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    )
  })

  it('canonicalises a document to its own route', () => {
    expect(documentCanonicalUrl(doc({ type: 'note', slug: '笔记' }))).toBe(
      `${siteOrigin}/notes/${encodeURIComponent('笔记')}`,
    )
  })
})

describe('resolveTitle', () => {
  it('suffixes the site name onto a page title', () => {
    expect(resolveTitle('Hello World', site)).toBe('Hello World · My Blog')
  })

  it('does not suffix a page that already is the site', () => {
    expect(resolveTitle('My Blog', site)).toBe('My Blog')
  })

  it('honours a template, including one that wants no suffix', () => {
    expect(resolveTitle('Hello', { ...site, titleTemplate: '%s' })).toBe('Hello')
    expect(resolveTitle('Hello', { ...site, titleTemplate: '%s | My Blog' })).toBe(
      'Hello | My Blog',
    )
  })

  it('truncates once, dropping the suffix rather than cutting the title twice', () => {
    const long = '网络调试与性能分析笔记'.repeat(8)
    const title = resolveTitle(long, site)

    expect(title).not.toContain(site.name)
    expect(Array.from(title).length).toBeLessThanOrEqual(61)
    expect(title.endsWith('…')).toBe(true)
  })

  it('measures a Chinese title in half-width units, like the description budget', () => {
    // 32 Chinese characters: 64 units of title, before the suffix. Counting
    // characters would call this a 32-character title and keep it whole, which
    // is twice the width a title tag has room for.
    const title = resolveTitle('网络调试与性能分析'.repeat(4), site)

    expect(title).not.toContain(site.name)
    expect(displayWidth(title)).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('keeps a title that fits, suffix and all', () => {
    const title = resolveTitle('a'.repeat(40), site)
    expect(title).toBe(`${'a'.repeat(40)} · My Blog`)
    expect(title).not.toContain('…')
  })
})

describe('truncateDescription', () => {
  it('leaves a description that fits alone', () => {
    expect(truncateDescription('很短的一句话。')).toBe('很短的一句话。')
    expect(truncateDescription('')).toBe('')
  })

  it('cuts Chinese text on a character boundary', () => {
    const input = '技术笔记与性能分析'.repeat(60)
    const out = truncateDescription(input)

    expect(out.endsWith('…')).toBe(true)
    expect(displayWidth(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_WIDTH)
    // Every character is one the input contained. A byte-boundary cut leaves a
    // replacement character here, which is what mojibake in a search result is.
    const body = out.slice(0, -1)
    expect([...body].every((char) => '技术笔记与性能分析'.includes(char))).toBe(true)
    expect(out).not.toContain(REPLACEMENT)
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
  })

  it('never splits a surrogate pair', () => {
    const input = `${'a'.repeat(60)} 😀😀😀 ${'b'.repeat(400)}`
    const out = truncateDescription(input)

    expect(out).not.toContain(REPLACEMENT)
    expect(out).toContain('😀😀😀')
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
    const body = out.endsWith('…') ? out.slice(0, -1) : out
    expect([...body].every((char) => input.includes(char))).toBe(true)
  })

  it('breaks at a sentence ending when there is one in range', () => {
    // The sentence has to reach half the budget before it is preferred: a first
    // sentence of ten characters would cut away two thirds of the room the
    // description is allowed, which reads as a bug rather than as care.
    const sentence = `${'内容'.repeat(43)}。`
    const out = truncateDescription(`${sentence}${'后续内容'.repeat(80)}`)

    expect(out).toBe(`${sentence}…`)
    expect(displayWidth(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_WIDTH)
  })

  it('breaks at a word boundary rather than mid-word', () => {
    const out = truncateDescription(`${'word '.repeat(200)}`)
    expect(out.endsWith('…')).toBe(true)
    expect(out.slice(0, -1).endsWith('word')).toBe(true)
  })

  it('counts a Chinese character as two units, not one', () => {
    const latin = truncateDescription('a'.repeat(400))
    const chinese = truncateDescription('中'.repeat(400))
    // Roughly half as many characters, because each takes twice the room.
    expect(Array.from(chinese).length).toBeLessThan(Array.from(latin).length * 0.6)
    expect(displayWidth(chinese)).toBeLessThanOrEqual(MAX_DESCRIPTION_WIDTH)
  })
})

describe('buildContentMetadata', () => {
  it('derives a description from the body when the frontmatter has none', () => {
    const metadata = buildContentMetadata(site, doc({ description: null, body: '# 标题\n\n正文内容。' }))
    expect(metadata.description).toBe('标题 正文内容。')
  })

  it('lets the frontmatter seo block override everything it names', () => {
    const metadata = buildContentMetadata(
      site,
      doc({
        seo: {
          title: 'Overridden',
          description: 'Overridden description',
          canonical: 'https://elsewhere.example.com/original',
          ogImage: '/uploads/cover.png',
          noindex: false,
        },
      }),
    )

    expect(metadata.title).toEqual({ absolute: 'Overridden · My Blog' })
    expect(metadata.description).toBe('Overridden description')
    expect(metadata.alternates?.canonical).toBe('https://elsewhere.example.com/original')
    expect(ogImageUrls(metadata)).toEqual([`${siteOrigin}/uploads/cover.png`])
  })

  it('reads the flat column spelling a database row uses', () => {
    const metadata = buildContentMetadata(
      site,
      doc({ seoTitle: 'Row title', canonicalUrl: '/posts/from-row', noindex: true }),
    )

    expect(metadata.title).toEqual({ absolute: 'Row title · My Blog' })
    expect(metadata.alternates?.canonical).toBe(`${siteOrigin}/posts/from-row`)
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it('carries an absolute canonical, og:image and twitter image', () => {
    const metadata = buildContentMetadata(site, doc())

    expect(metadata.alternates?.canonical).toBe(`${siteOrigin}/posts/hello-world`)
    const [url] = ogImageUrls(metadata)
    expect(url?.startsWith(`${siteOrigin}/api/og?`)).toBe(true)
    expect(metadata.twitter?.images).toEqual([url])
  })

  it('asks crawlers to index an ordinary document', () => {
    expect(buildContentMetadata(site, doc()).robots).toBeUndefined()
  })
})

describe('buildPageMetadata', () => {
  it('builds the canonical from the path, keeping a query string', () => {
    const metadata = buildPageMetadata({
      site,
      title: 'Search',
      path: '/search?q=%E7%BD%91%E7%BB%9C&page=2',
    })
    expect(metadata.alternates?.canonical).toBe(
      `${siteOrigin}/search?q=%E7%BD%91%E7%BB%9C&page=2`,
    )
    // The path is carried through as written rather than re-encoded: the routes
    // that build one already encoded it, and encoding twice is worse than not
    // encoding at all.
    expect(
      buildPageMetadata({ site, title: 'Search', path: '/search?q=网络' }).alternates
        ?.canonical,
    ).toBe(`${siteOrigin}/search?q=网络`)
  })

  it('keeps a trailing slash the route actually serves', () => {
    expect(
      buildPageMetadata({ site, title: 'Tags', path: '/tags/' }).alternates?.canonical,
    ).toBe(`${siteOrigin}/tags/`)
  })

  it('asks for noindex and nofollow together, and only when asked', () => {
    const hidden = buildPageMetadata({ site, title: 'Admin', path: '/admin', noindex: true })
    expect(hidden.robots).toEqual({ index: false, follow: false })
    // `follow: false` as well: a noindex page that is still followed leaks the
    // whole admin section into the index through its links.
    expect(buildPageMetadata({ site, title: 'Home', path: '/' }).robots).toBeUndefined()
  })

  it('advertises the site feeds on a page that is not about a topic', () => {
    const metadata = buildPageMetadata({ site, title: 'Archive', path: '/archive' })

    // Stated per page rather than left to the root layout, and this is the
    // assertion that says why: Next replaces `alternates` wholesale when a page
    // sets it, so a layout that advertises the feeds reaches only the pages that
    // set no metadata of their own — the home page and nothing else. Every
    // other page carried a canonical and no feed link at all.
    expect(metadata.alternates).toEqual({
      canonical: `${siteOrigin}/archive`,
      types: {
        'application/rss+xml': SITE_RSS_PATH,
        'application/atom+xml': SITE_ATOM_PATH,
      },
    })
  })

  it('advertises a topic feed instead of the site feeds', () => {
    const metadata = buildPageMetadata({
      site,
      title: '#linux',
      path: '/tags/linux',
      feed: '/rss/linux.xml',
    })

    // One `application/rss+xml` alternate, not two. A reader on a tag page is
    // asking to follow that tag, and an aggregator handed a choice of two feeds
    // of the same type picks whichever it comes to first.
    expect(metadata.alternates?.types).toEqual({
      'application/rss+xml': '/rss/linux.xml',
    })
    expect(metadata.alternates?.canonical).toBe(`${siteOrigin}/tags/linux`)
  })

  it('uses the article type only for an article', () => {
    const article = buildPageMetadata({
      site,
      title: 'Hello',
      path: '/posts/hello',
      type: 'article',
      publishedTime: new Date('2026-01-02T12:00:00.000Z'),
    })
    const page = buildPageMetadata({ site, title: 'About', path: '/about' })

    expect(article.openGraph).toMatchObject({
      type: 'article',
      publishedTime: '2026-01-02T12:00:00.000Z',
    })
    expect(page.openGraph).toMatchObject({ type: 'website' })
    expect(page.openGraph).not.toHaveProperty('publishedTime')
  })

  it('links to absolute images and a generated card by default', () => {
    const metadata = buildPageMetadata({ site, title: 'Hello', path: '/posts/hello' })
    const [url] = ogImageUrls(metadata)

    expect(url?.startsWith(`${siteOrigin}/api/og?`)).toBe(true)
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' })
    expect(metadata.openGraph).toMatchObject({ siteName: 'My Blog', locale: 'zh-CN' })
  })
})

describe('rfc822', () => {
  it('writes an RFC 822 date, not an ISO one', () => {
    expect(rfc822(new Date('2026-01-02T12:00:00.000Z'))).toBe(
      'Fri, 02 Jan 2026 12:00:00 GMT',
    )
    // An ISO `pubDate` of `2026-01-02T12:00:00.000Z` is the mistake this guards
    // against: readers parse it as an invalid date and drop the item.
    expect(rfc822(new Date('2026-01-02T12:00:00.000Z'))).not.toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    )
    expect(rfc822(new Date('2026-01-02T12:00:00.000Z'))).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    )
  })
})

describe('siteIdentityFromSettings', () => {
  it('maps the settings row onto the identity every surface reads', () => {
    const identity = siteIdentityFromSettings({
      ...SETTINGS_DEFAULTS,
      siteName: 'Example',
      siteDescription: '页面上的站点介绍',
      seoDefaultDescription: '',
      authorName: 'Xie Chengan',
      twitterHandle: '@example',
      seoTitleTemplate: '%s | Example',
    })

    expect(identity).toEqual({
      name: 'Example',
      description: '页面上的站点介绍',
      authorName: 'Xie Chengan',
      locale: 'zh-CN',
      twitterHandle: '@example',
      titleTemplate: '%s | Example',
    })
  })

  it('prefers the SEO description when one is set', () => {
    const identity = siteIdentityFromSettings({
      ...SETTINGS_DEFAULTS,
      seoDefaultDescription: 'meta 描述',
    })
    expect(identity.description).toBe('meta 描述')
  })

  it('composes a title through the settings template', () => {
    const identity = siteIdentityFromSettings({
      ...SETTINGS_DEFAULTS,
      siteName: 'Example',
      seoTitleTemplate: '%s | Example',
    })
    expect(resolveTitle('Hello', identity)).toBe('Hello | Example')
  })
})

describe('isPublic', () => {
  const now = new Date('2026-09-11T00:00:00.000Z')

  it('accepts a published, past-dated document', () => {
    expect(isPublic(doc(), now)).toBe(true)
  })

  it('rejects drafts, archived documents and anything dated in the future', () => {
    expect(isPublic(doc({ status: 'draft' }), now)).toBe(false)
    expect(isPublic(doc({ status: 'archived' }), now)).toBe(false)
    expect(isPublic(doc({ publishedAt: new Date('2027-01-01T00:00:00Z') }), now)).toBe(false)
    expect(isPublic(doc({ publishedAt: null }), now)).toBe(false)
  })

  it('goes live on a schedule whose moment has passed, as the site lists do', () => {
    // The worker normally flips the row to `published`; until it runs, the post
    // is served and listed, so it belongs in the sitemap and the feed too.
    expect(isPublic(doc({ status: 'scheduled', scheduledAt: new Date('2026-01-02T12:00:00Z') }), now)).toBe(true)
    expect(isPublic(doc({ status: 'scheduled', scheduledAt: new Date('2026-10-01T00:00:00Z') }), now)).toBe(false)
    // A scheduled document must carry its moment; without one it never goes
    // live, which is what the frontmatter schema enforces at write time.
    expect(isPublic(doc({ status: 'scheduled', publishedAt: null }), now)).toBe(false)
  })

  it('rejects anything that opted out of indexing', () => {
    expect(isPublic(doc({ noindex: true }), now)).toBe(false)
    expect(isPublic(doc({ seo: { noindex: true } }), now)).toBe(false)
  })
})

describe('resolveSeoFields', () => {
  it('prefers the nested block over the flat columns', () => {
    expect(
      resolveSeoFields(doc({ seoTitle: 'Flat', seo: { title: 'Nested' } })).title,
    ).toBe('Nested')
  })

  it('defaults noindex to false rather than undefined', () => {
    expect(resolveSeoFields(doc()).noindex).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Sitemap                                                                    */
/* -------------------------------------------------------------------------- */

describe('buildSitemapEntries', () => {
  const now = new Date('2026-09-11T00:00:00.000Z')

  it('lists the static pages and every published document', () => {
    const entries = buildSitemapEntries({ documents: [doc()], now })
    const urls = entries.map((entry) => entry.url)

    for (const route of STATIC_ROUTES) {
      expect(urls).toContain(`${siteOrigin}${route.path}`)
    }
    expect(urls).toContain(`${siteOrigin}/posts/hello-world`)
  })

  it('leaves drafts, archived documents and future dates out', () => {
    const entries = buildSitemapEntries({
      documents: [
        doc({ slug: 'live' }),
        doc({ slug: 'draft', status: 'draft' }),
        doc({ slug: 'archived', status: 'archived' }),
        doc({ slug: 'future', publishedAt: new Date('2027-01-01T00:00:00Z') }),
        doc({ slug: 'undated', publishedAt: null }),
        // Published and served by the site, so it belongs here too.
        doc({ slug: 'scheduled', status: 'scheduled', scheduledAt: new Date('2026-09-01T00:00:00Z') }),
        // Scheduled, and its moment has not come.
        doc({ slug: 'later', status: 'scheduled', scheduledAt: new Date('2026-10-01T00:00:00Z') }),
      ],
      now,
    })

    expect(entries.map((entry) => entry.url).filter((url) => url.includes('/posts/'))).toEqual([
      `${siteOrigin}/posts/live`,
      `${siteOrigin}/posts/scheduled`,
    ])
  })

  it('leaves noindex documents out', () => {
    const entries = buildSitemapEntries({
      documents: [doc({ slug: 'hidden', noindex: true })],
      now,
    })
    expect(entries.map((entry) => entry.url)).not.toContain(`${siteOrigin}/posts/hidden`)
  })

  it('dates entries from the document, not from the request', () => {
    const entries = buildSitemapEntries({ documents: [doc()], now })
    const post = entries.find((entry) => entry.url.endsWith('/posts/hello-world'))

    expect(post?.lastModified).toEqual(new Date('2026-02-03T12:00:00.000Z'))
    expect(post?.changeFrequency).toBe('monthly')
    expect(post?.priority).toBe(0.8)
  })

  it('gives a page that lists content a date, and one that does not no date', () => {
    const entries = buildSitemapEntries({ documents: [doc()], now })
    const home = entries.find((entry) => entry.url === `${siteOrigin}/`)
    const about = entries.find((entry) => entry.url === `${siteOrigin}/about`)

    expect(home?.lastModified).toEqual(new Date('2026-02-03T12:00:00.000Z'))
    expect(about?.lastModified).toBeUndefined()
  })

  it('gives every entry an absolute URL', () => {
    const entries = buildSitemapEntries({ documents: [doc()], now })
    for (const entry of entries) {
      expect(entry.url.startsWith(`${siteOrigin}/`)).toBe(true)
    }
  })

  it('lists a tag page by its slug, not by the name it is filed under', () => {
    const entries = buildSitemapEntries({
      documents: [doc({ tags: ['C++'] })],
      tagSlugs: new Map([['C++', 'c-plus-plus']]),
      now,
    })

    expect(entries.map((entry) => entry.url)).toContain(`${siteOrigin}/tags/c-plus-plus`)
  })

  it('lists a tag page only while something is filed under the tag', () => {
    const entries = buildSitemapEntries({
      documents: [
        doc({ slug: 'live', tags: ['linux'] }),
        doc({ slug: 'hidden', tags: ['secret'], noindex: true }),
      ],
      // Three tags have pages; only one of them has a document a crawler may
      // see. The other two would be URLs that 404 or that lead to the only
      // page the author asked not to be indexed.
      tagSlugs: new Map([
        ['linux', 'linux'],
        ['secret', 'secret'],
        ['unused', 'unused'],
      ]),
      now,
    })

    const urls = entries.map((entry) => entry.url)
    expect(urls).toContain(`${siteOrigin}/tags/linux`)
    expect(urls).not.toContain(`${siteOrigin}/tags/secret`)
    expect(urls).not.toContain(`${siteOrigin}/tags/unused`)
  })

  it('dates a tag page from the newest document behind it', () => {
    const entries = buildSitemapEntries({
      documents: [
        doc({ slug: 'older', tags: ['linux'], updatedAt: new Date('2026-02-01T00:00:00Z') }),
        doc({ slug: 'newer', tags: ['linux'], updatedAt: new Date('2026-03-01T00:00:00Z') }),
      ],
      tagSlugs: new Map([['linux', 'linux']]),
      now,
    })

    expect(entries.find((entry) => entry.url.endsWith('/tags/linux'))?.lastModified).toEqual(
      new Date('2026-03-01T00:00:00.000Z'),
    )
  })

  it('orders tag pages the way the site lists tags, not the way rows arrived', () => {
    const entries = buildSitemapEntries({
      documents: [doc({ tags: ['rare'] }), doc({ slug: 'second', tags: ['common'] })],
      // The map is built from a list ordered most-used first, and insertion
      // order is what carries that through.
      tagSlugs: new Map([
        ['common', 'common'],
        ['rare', 'rare'],
      ]),
      now,
    })

    const tags = entries.map((entry) => entry.url).filter((url) => url.includes('/tags/'))
    expect(tags).toEqual([`${siteOrigin}/tags/common`, `${siteOrigin}/tags/rare`])
  })

  it('lists a series page for the documents that belong to one', () => {
    const entries = buildSitemapEntries({
      documents: [doc({ series: 'Rebuilding the blog' }), doc({ slug: 'loose' })],
      now,
    })

    const urls = entries.map((entry) => entry.url)
    // Encoded the way the page's own canonical URL is: a series is a string an
    // author typed, not a slug.
    expect(urls).toContain(`${siteOrigin}/series/Rebuilding%20the%20blog`)
    expect(urls.some((url) => url.includes('/series/undefined'))).toBe(false)
  })

  it('leaves the tag pages out when the caller cannot supply their slugs', () => {
    const entries = buildSitemapEntries({ documents: [doc({ tags: ['linux'] })], now })

    expect(entries.some((entry) => entry.url.includes('/tags/'))).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

interface RobotsRule {
  userAgent?: string | string[]
  allow?: string | string[]
  disallow?: string | string[]
}

function robotsRules(): RobotsRule[] {
  const { rules } = buildRobots()
  if (!rules) return []
  return Array.isArray(rules) ? rules : [rules]
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

describe('buildRobots', () => {
  it('disallows the admin, the API and the preview routes explicitly', () => {
    const disallowed = robotsRules().flatMap((rule) => asArray(rule.disallow))

    expect(disallowed).toContain('/admin')
    expect(disallowed).toContain('/api/')
    expect(disallowed).toContain('/preview/')
  })

  it('never allows a path it also disallows', () => {
    for (const rule of robotsRules()) {
      const allowed = asArray(rule.allow)
      const disallowed = asArray(rule.disallow)
      for (const path of disallowed) {
        expect(allowed).not.toContain(path)
      }
    }
  })

  it('has no empty disallow, which would mean "crawl everything"', () => {
    const disallowed = robotsRules().flatMap((rule) => asArray(rule.disallow))
    expect(disallowed.length).toBeGreaterThan(0)
    for (const path of disallowed) {
      expect(path.trim()).not.toBe('')
      expect(path.startsWith('/')).toBe(true)
    }
  })

  it('blocks the real URLs by prefix, not just the bare prefixes', () => {
    const disallowed = robotsRules().flatMap((rule) => asArray(rule.disallow))
    const blocked = (url: string): boolean =>
      disallowed.some((path) => url.startsWith(path))

    // The paths that matter are never the prefix itself.
    expect(blocked('/admin')).toBe(true)
    expect(blocked('/admin/login')).toBe(true)
    expect(blocked('/admin/content/2026/edit')).toBe(true)
    expect(blocked('/api/preview/post/hello')).toBe(true)
    expect(blocked('/api/search?q=x')).toBe(true)
  })

  it('applies to every crawler rather than to none', () => {
    for (const rule of robotsRules()) {
      expect(asArray(rule.userAgent)).toContain('*')
    }
  })

  it('points at an absolute sitemap URL', () => {
    expect(buildRobots().sitemap).toBe(`${siteOrigin}/sitemap.xml`)
  })
})

/* -------------------------------------------------------------------------- */
/*  Open Graph card layout                                                     */
/* -------------------------------------------------------------------------- */

describe('layoutTitle', () => {
  it('keeps a short title on one line at the largest size', () => {
    const layout = layoutTitle('Linux Network Debugging')
    expect(layout.fontSize).toBe(72)
    expect(layout.lines).toEqual(['Linux Network Debugging'])
    expect(layout.truncated).toBe(false)
  })

  it('breaks a long Chinese title between characters, never past the edge', () => {
    const layout = layoutTitle('网络调试与性能分析笔记'.repeat(6))

    expect(layout.lines.length).toBeGreaterThan(1)
    expect(layout.lines.length).toBeLessThanOrEqual(3)
    for (const line of layout.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(unitsPerLine(layout.fontSize))
    }
    // Every character survives: lines are cut between characters, not bytes.
    expect(layout.lines.join('')).toBe('网络调试与性能分析笔记'.repeat(6))
  })

  it('shrinks the type before it truncates the title', () => {
    // 44 Chinese characters: four lines at 72px, three at 60px. Shrinking is
    // what keeps the title whole, so this one must not be cut.
    const medium = layoutTitle('网络性能分析与排查方法'.repeat(4))
    expect(medium.truncated).toBe(false)
    expect(medium.fontSize).toBeLessThan(72)
    expect(medium.lines.length).toBeLessThanOrEqual(3)
  })

  it('truncates only when the smallest size still does not fit', () => {
    const layout = layoutTitle('标题'.repeat(200))

    expect(layout.truncated).toBe(true)
    expect(layout.fontSize).toBe(42)
    expect(layout.lines.length).toBe(3)
    expect(layout.lines[2]?.endsWith('…')).toBe(true)
    for (const line of layout.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(unitsPerLine(42))
    }
  })

  it('breaks between Latin words, not inside them', () => {
    const text = 'debugging network throughput on a linux box'
    const words = new Set(text.split(' '))
    const layout = layoutTitle(text)

    expect(layout.truncated).toBe(false)
    expect(layout.lines.length).toBeGreaterThan(1)
    for (const line of layout.lines) {
      expect(line.startsWith(' ')).toBe(false)
      expect(line.endsWith(' ')).toBe(false)
      // Every piece is a whole word: a break inside one would leave a fragment
      // like `debug` here, which is what the check is for.
      for (const word of line.split(' ')) {
        expect(words.has(word)).toBe(true)
      }
    }
    expect(layout.lines.join(' ')).toBe(text)
  })

  it('handles an empty title without producing a line', () => {
    expect(layoutTitle('').lines).toEqual([])
  })
})

describe('renderOgImage', () => {
  it('renders a PNG', async () => {
    const response = await renderOgImage({
      title: '网络调试笔记',
      site,
      label: 'post',
      publishedAt: new Date('2026-09-11T00:00:00.000Z'),
      tags: ['linux', 'network'],
    })

    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('s-maxage')

    const bytes = Buffer.from(await response.arrayBuffer())
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('ships a font that actually covers Chinese', async () => {
    // A Latin-only font here produces cards full of empty boxes, and nothing
    // else in the build would notice, so the coverage is asserted directly.
    expect(fontCoversCodePoint(OG_FONT_PATH, 0x7f51)).toBe(true) // 网
    expect(fontCoversCodePoint(OG_FONT_PATH, 0x7edc)).toBe(true) // 络
    expect(fontCoversCodePoint(OG_FONT_PATH, 0x4e00)).toBe(true) // 一
    expect(fontCoversCodePoint(OG_FONT_PATH, 0x41)).toBe(true) // A

    const font = await loadOgFont()
    expect(font?.byteLength).toBe(fs.statSync(OG_FONT_PATH).size)
  })
})

/**
 * True when a TrueType file's Unicode (3,1) cmap maps `codePoint`.
 *
 * Enough of the format to answer one question: does this font claim to draw
 * this character? Parsing the whole file would need a font library for a check
 * that only has to notice a missing glyph.
 */
function fontCoversCodePoint(file: string, codePoint: number): boolean {
  const font = fs.readFileSync(file)

  let cmapOffset = -1
  const tableCount = font.readUInt16BE(4)
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16
    if (font.toString('ascii', record, record + 4) === 'cmap') {
      cmapOffset = font.readUInt32BE(record + 8)
      break
    }
  }
  if (cmapOffset < 0) return false

  const subtableCount = font.readUInt16BE(cmapOffset + 2)
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + index * 8
    if (font.readUInt16BE(record) !== 3 || font.readUInt16BE(record + 2) !== 1) {
      continue
    }

    const subtable = cmapOffset + font.readUInt32BE(record + 4)
    if (font.readUInt16BE(subtable) !== 4) continue

    const segmentCount = font.readUInt16BE(subtable + 6) / 2
    const endCodes = subtable + 14
    const startCodes = endCodes + segmentCount * 2 + 2

    for (let segment = 0; segment < segmentCount; segment += 1) {
      const end = font.readUInt16BE(endCodes + segment * 2)
      if (codePoint > end) continue
      return codePoint >= font.readUInt16BE(startCodes + segment * 2)
    }
    return false
  }

  return false
}
