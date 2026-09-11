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
    author: site.authorName
      ? compact({ '@type': 'Person', name: site.authorName })
      : undefined,
    publisher: compact({
      '@type': 'Organization',
      name: site.name,
      url: `${siteOrigin}/`,
    }),
    image: input.imageUrl ? absoluteUrl(input.imageUrl) : undefined,
    inLanguage: site.locale ?? undefined,
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

export function buildPersonJsonLd(
  input: PersonJsonLdInput,
): Record<string, unknown> {
  return compact({
    '@context': SCHEMA,
    '@type': 'Person',
    name: input.name,
    url: input.url ? absoluteUrl(input.url) : undefined,
    image: input.image ? absoluteUrl(input.image) : undefined,
    description: input.description ?? undefined,
    jobTitle: input.jobTitle ?? undefined,
    sameAs: input.sameAs && input.sameAs.length > 0 ? [...input.sameAs] : undefined,
  })
}
