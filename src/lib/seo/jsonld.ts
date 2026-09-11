import { createElement, type ReactElement } from 'react'
import { siteOrigin } from '@/env'
import {
  absoluteUrl,
  documentCanonicalUrl,
  resolveDescription,
  resolveSeoFields,
  tagNames,
  type SeoDocument,
  type SiteIdentity,
} from './metadata'

/**
 * Structured data.
 *
 * Two rules hold for everything in this file.
 *
 * Fields are emitted only when they carry a value. `"image": null` is not a
 * smaller version of an image — it tells a consumer the field exists and hands
 * it nothing to read, which is worse than saying nothing at all. Every object
 * is built through `compact` for that reason.
 *
 * Text is escaped before it reaches the script element. `JSON.stringify` does
 * not escape `</script>`, so a document whose title contains it ends the script
 * element early and everything after it is markup — that is an XSS hole
 * reachable by anyone who can write frontmatter, and frontmatter is the one
 * input this site takes from outside the codebase.
 */

/* -------------------------------------------------------------------------- */
/*  Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escaped because none of these are safe to emit into a `<script>` element.
 *
 * `<`, `>` and `&` can close the element or start an entity; U+2028 and U+2029
 * are line terminators that JSON permits inside a string but JavaScript did not
 * — they were a syntax error in older parsers and are still the ones that slip
 * through a naive check. All five become `\uXXXX` escapes, which inside a JSON
 * string are the same characters: `JSON.parse` returns the original text.
 */
const UNSAFE_IN_SCRIPT = /[<>&\u2028\u2029]/g

const SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

export function serializeJsonLd(data: unknown): string {
  const json = JSON.stringify(data)
  return (json ?? 'null').replace(
    UNSAFE_IN_SCRIPT,
    (char) => SCRIPT_ESCAPES[char] ?? char,
  )
}

/* -------------------------------------------------------------------------- */
/*  Shape helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Drop entries that carry no value.
 *
 * Shallow, and deliberately so: the objects here are one level deep apart from
 * a nested `mainEntityOfPage`, which is always populated when it is built.
 */
export function compact(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

/** One node, or several to be emitted as a single `@graph`. */
export type JsonLdValue =
  | Record<string, unknown>
  | readonly Record<string, unknown>[]

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface JsonLdProps {
  data: JsonLdValue
}

/**
 * A `<script type="application/ld+json">` element.
 *
 * `dangerouslySetInnerHTML` is the only way to place text in a script element —
 * React escapes children as markup, which produces a script containing escaped
 * text rather than JSON. The escaping in `serializeJsonLd` is what makes that
 * safe, and it is tested against the `</script>` breakout.
 *
 * Written with `createElement` because a `.ts` file cannot hold JSX, and one
 * component is not worth a `.tsx` sibling.
 */
export function JsonLd({ data }: JsonLdProps): ReactElement {
  const value = Array.isArray(data)
    ? { '@context': 'https://schema.org', '@graph': data }
    : data

  return createElement('script', {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: { __html: serializeJsonLd(value) },
  })
}

/* -------------------------------------------------------------------------- */
/*  Nodes                                                                      */
/* -------------------------------------------------------------------------- */

const SCHEMA = 'https://schema.org'

export interface ArticleJsonLdInput {
  site: SiteIdentity
  doc: SeoDocument
  /** Absolute URL of the article. Defaults to its canonical URL. */
  url?: string
  /** Absolute or site-relative image. Omit for no image field at all. */
  imageUrl?: string | null
  /**
   * `@id` of the author node, from `authorNodeId`. Omitted when the site has no
   * author name — and the caller passes that same `null` through, so the
   * reference and the Person page appear and disappear together.
   */
  authorId?: string | null
}

/**
 * `@type` per content type.
 *
 *   post    → `BlogPosting`. The specific type Google's article guidance names,
 *             and what a dated, titled entry in a feed is.
 *   note    → `TechArticle`. A note is documented know-how, not a blog post:
 *             it may have no date and no title of its own, which `BlogPosting`
 *             requires and `TechArticle` does not.
 *   project → `SoftwareSourceCode` when the document points at a repository,
 *             `CreativeWork` when it does not. `SoftwareSourceCode` promises a
 *             code artifact; a project page with no repo is a write-up about
 *             one, and claiming otherwise is a claim the page cannot support.
 */
function articleType(doc: SeoDocument): string {
  switch (doc.type) {
    case 'post':
      return 'BlogPosting'
    case 'note':
      return 'TechArticle'
    case 'project':
      return doc.repoUrl ? 'SoftwareSourceCode' : 'CreativeWork'
  }
}

export function buildArticleJsonLd(
  input: ArticleJsonLdInput,
): Record<string, unknown> {
  const { site, doc } = input
  const seo = resolveSeoFields(doc)
  const title = seo.title?.trim() || doc.title
  const url = input.url ? absoluteUrl(input.url) : documentCanonicalUrl(doc)
  const type = articleType(doc)
  // The same description the page and the feed carry, so a consumer that reads
  // two of them never has to reconcile a difference.
  const description = resolveDescription(doc, site)

  return compact({
    '@context': SCHEMA,
    '@type': type,
    headline: title,
    // `name` as well as `headline`: `headline` belongs to the Article family,
    // and `CreativeWork` consumers read `name`.
    name: title,
    description,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: doc.publishedAt?.toISOString(),
    dateModified: (doc.updatedAt ?? doc.publishedAt)?.toISOString(),
    // A name as well as the reference: a consumer that does not merge graphs
    // still reads who wrote this, and one that does follows `@id` to the
    // Person on the about page rather than inventing a second author.
    author: site.authorName
      ? compact({
          '@type': 'Person',
          '@id': input.authorId ?? undefined,
          name: site.authorName,
        })
      : undefined,
    publisher: compact({
      '@type': 'Organization',
      name: site.name,
      url: `${siteOrigin}/`,
    }),
    image: input.imageUrl ? absoluteUrl(input.imageUrl) : undefined,
    /*
     * The document's own language first.
     *
     * This used to be the site's locale unconditionally, which is right only on
     * a monolingual site. On a bilingual one it publishes a claim that
     * contradicts the page: `<article lang>` says the note is in Chinese and
     * this says it is in the site's default language, and a consumer that reads
     * both — or that reads only this one — gets the wrong answer about a
     * document it cannot see. The site's locale stays as the fallback for
     * callers whose row did not carry a language.
     */
    inLanguage: doc.lang ?? site.locale ?? undefined,
    keywords: tagNames(doc.tags).join(', ') || undefined,
    articleSection: doc.category ?? undefined,
    isPartOf: doc.series
      ? compact({ '@type': 'CreativeWorkSeries', name: doc.series })
      : undefined,
    codeRepository: doc.repoUrl ?? undefined,
    // A project's own site, where it is distinct from the repository.
    sameAs: doc.websiteUrl ?? undefined,
  })
}

export interface WebsiteJsonLdInput {
  site: SiteIdentity
  /** Site-relative or absolute URL of the home page. */
  url?: string
  /** Search endpoint, if the site has one; enables the sitelinks search box. */
  searchUrl?: string | null
}

export function buildWebsiteJsonLd(
  input: WebsiteJsonLdInput,
): Record<string, unknown> {
  const { site } = input
  const url = absoluteUrl(input.url ?? '/')

  return compact({
    '@context': SCHEMA,
    '@type': 'WebSite',
    name: site.name,
    url,
    description: site.description ?? undefined,
    inLanguage: site.locale ?? undefined,
    publisher: compact({
      '@type': 'Organization',
      name: site.name,
      url: `${siteOrigin}/`,
    }),
    potentialAction: input.searchUrl
      ? compact({
          '@type': 'SearchAction',
          target: compact({
            '@type': 'EntryPoint',
            urlTemplate: `${absoluteUrl(input.searchUrl)}{?q}`,
          }),
          'query-input': 'required name=q',
        })
      : undefined,
  })
}

export interface BreadcrumbItem {
  name: string
  /** Site-relative or absolute. Omitted for the current page if unknown. */
  url?: string | null
}

export function buildBreadcrumbJsonLd(
  items: readonly BreadcrumbItem[],
): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) =>
      compact({
        '@type': 'ListItem',
        // Positions are 1-based in schema.org.
        position: index + 1,
        name: item.name,
        item: item.url ? absoluteUrl(item.url) : undefined,
      }),
    ),
  }
}

export interface PersonJsonLdInput {
  name: string
  url?: string | null
  image?: string | null
  description?: string | null
  jobTitle?: string | null
  /** Other profiles that identify the same person, e.g. GitHub, X. */
  sameAs?: readonly string[]
}

/** Where the author's own page lives. */
export const ABOUT_PATH = '/about'

/**
 * The `@id` of the author, or `null` when there is no author to name.
 *
 * One node, referenced from everywhere the author is mentioned. An article's
 * `author` carrying only a name is a different Person every time it appears —
 * four articles by "Xie Chengan" are four strangers who happen to share a
 * string — and a consumer that wants to know who wrote the site has nowhere to
 * look. With an `@id` the article's author and the Person on the about page are
 * the same entity, and the article's own reference is enough to resolve it.
 *
 * `null` rather than a default when the site has no author name, because there
 * is nothing true to say: an unset author is not the site name, and a `@id`
 * pointing at a node no page defines is worse than no reference at all — a
 * consumer that resolves it finds nothing and cannot tell that from a mistake.
 * Callers pass the result straight through as `authorId`, so the reference and
 * the node are published or withheld together.
 *
 * The fragment is on the about page's URL rather than a URL of its own because
 * the Person is that page's main entity: `#person` is where the page's subject
 * already is, and it costs no extra address that could 404.
 */
export function authorNodeId(
  authorName: string | null | undefined,
  aboutUrl: string = ABOUT_PATH,
): string | null {
  if (!authorName?.trim()) return null
  return `${absoluteUrl(aboutUrl)}#person`
}

export function buildPersonJsonLd(
  input: PersonJsonLdInput,
): Record<string, unknown> {
  const url = absoluteUrl(input.url ?? ABOUT_PATH)

  return compact({
    '@context': SCHEMA,
    '@type': 'Person',
    // The same id `authorNodeId` hands to every article, computed from the same
    // URL, so the two cannot drift into two nodes with one name.
    '@id': authorNodeId(input.name, url) ?? undefined,
    name: input.name,
    url,
    image: input.image ? absoluteUrl(input.image) : undefined,
    description: input.description ?? undefined,
    jobTitle: input.jobTitle ?? undefined,
    sameAs: input.sameAs && input.sameAs.length > 0 ? [...input.sameAs] : undefined,
  })
}
