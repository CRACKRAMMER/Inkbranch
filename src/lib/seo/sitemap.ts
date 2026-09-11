import type { MetadataRoute } from 'next'
import { documentUrl } from '@/lib/content/paths'
import type { ContentType } from '@/lib/content/schema'
import {
  absoluteUrl,
  effectivePublishedAt,
  isPublic,
  tagNames,
  type SeoDocument,
} from './metadata'

/**
 * The sitemap.
 *
 * The filtering is the part that matters. A sitemap is an instruction to index,
 * and the failure mode is silent: a draft that reaches this list is a draft
 * published by accident, to a crawler, before its author ever saw it live. So
 * the rule is one predicate — `isPublic` — shared with the feeds, and it is
 * tested against drafts, future-dated documents and `noindex` pages rather than
 * assumed.
 */

/** Change frequency and priority per content type. */
const CONTENT_RULES: Record<
  ContentType,
  { changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }
> = {
  // A post is corrected and extended, but it is not a living document: monthly
  // is what its revision history actually looks like.
  post: { changeFrequency: 'monthly', priority: 0.8 },
  // Notes are short and finish early.
  note: { changeFrequency: 'monthly', priority: 0.5 },
  // Projects move: status, stack and README change while they are maintained.
  project: { changeFrequency: 'weekly', priority: 0.7 },
}

/**
 * The pages that always exist, in the order a crawler should meet them.
 *
 * `listsContent` marks the routes whose contents are the archive itself, so
 * their `lastModified` can be taken from the newest document. `/about` and
 * `/graph` have no such source — `/about` is edited in settings, `/graph` is
 * drawn on the client — and a sitemap date that is not derived from the page's
 * real content is a date a crawler will learn to distrust.
 *
 * The three section indexes are here because they are the entry points a
 * reader actually uses, and leaving them out would tell a crawler the only way
 * into the site is the home page and the archive.
 *
 * `/search` is deliberately absent. It renders a results page behind a query
 * string, carries `noindex`, and has nothing to offer that the documents it
 * links to do not.
 *
 * Individual tag and series pages are not in this list because they are not
 * fixed: they exist only while something is filed under them. They are added by
 * `buildSitemapEntries` from the documents themselves — see `TOPIC_ROUTES`.
 */
export const STATIC_ROUTES: readonly {
  path: string
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']
  priority: number
  listsContent: boolean
}[] = [
  { path: '/', changeFrequency: 'daily', priority: 1, listsContent: true },
  { path: '/posts', changeFrequency: 'weekly', priority: 0.9, listsContent: true },
  { path: '/notes', changeFrequency: 'weekly', priority: 0.7, listsContent: true },
  { path: '/projects', changeFrequency: 'weekly', priority: 0.8, listsContent: true },
  { path: '/archive', changeFrequency: 'weekly', priority: 0.6, listsContent: true },
  { path: '/tags', changeFrequency: 'weekly', priority: 0.5, listsContent: true },
  { path: '/about', changeFrequency: 'monthly', priority: 0.5, listsContent: false },
  { path: '/graph', changeFrequency: 'monthly', priority: 0.3, listsContent: false },
]

/**
 * The two kinds of page that exist because a document mentions something.
 *
 * A series outranks a tag: it is a reading order, which is a route through the
 * site, where a tag is a set of things that happen to share a word. Both are
 * weekly, because both change exactly when a document filed under them does —
 * which is the same event their `lastModified` reports.
 *
 * The segment is encoded the same way the pages themselves encode it. A tag
 * slug is already URL-safe by construction, but a series is a frontmatter
 * string an author typed, and an unencoded space or `#` in it would produce a
 * sitemap URL that does not match the page it points at.
 */
const TOPIC_ROUTES = {
  tag: {
    path: (segment: string) => `/tags/${encodeURIComponent(segment)}`,
    changeFrequency: 'weekly' as const,
    priority: 0.4,
  },
  series: {
    path: (segment: string) => `/series/${encodeURIComponent(segment)}`,
    changeFrequency: 'weekly' as const,
    priority: 0.5,
  },
}

export interface SitemapInput {
  documents: readonly SeoDocument[]
  /**
   * Tag name → the slug its page is addressed by.
   *
   * A document carries tag *names* — that is what frontmatter has — and the tag
   * pages are addressed by slug, which is a different string whenever a name is
   * not already URL-safe (`C++` is filed under `c-plus-plus`). The mapping lives
   * in the `tags` table and is handed in rather than derived here, because
   * deriving it would be a second implementation of the rule that decides which
   * tag a URL means.
   *
   * A name absent from the map has no page and gets no entry. The caller passes
   * only tags that have published content behind them, which is the same
   * condition the tag route 404s on.
   */
  tagSlugs?: ReadonlyMap<string, string>
  /** Injected by tests; the route handler leaves it out. */
  now?: Date
}

/** Newest update across the documents a page lists, or nothing at all. */
function newestUpdate(documents: readonly SeoDocument[]): Date | undefined {
  let newest: Date | undefined
  for (const doc of documents) {
    const updated = doc.updatedAt ?? effectivePublishedAt(doc)
    if (!updated) continue
    if (!newest || updated.getTime() > newest.getTime()) newest = updated
  }
  return newest
}

export function buildSitemapEntries(input: SitemapInput): MetadataRoute.Sitemap {
  const now = input.now ?? new Date()
  const documents = input.documents.filter((doc) => isPublic(doc, now))
  const siteLastModified = newestUpdate(documents)

  const pages: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: route.listsContent ? siteLastModified : undefined,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }))

  const entries: MetadataRoute.Sitemap = documents.map((doc) => {
    const rules = CONTENT_RULES[doc.type]
    return {
      url: absoluteUrl(documentUrl(doc.type, doc.slug)),
      // The document's real update time. `updatedAt` is frontmatter `updated`
      // falling back to the file's mtime, which is the closest thing to the
      // truth this system has; a document that has never been edited falls back
      // to the moment it went live.
      lastModified: doc.updatedAt ?? effectivePublishedAt(doc),
      changeFrequency: rules.changeFrequency,
      priority: rules.priority,
    }
  })

  return [...pages, ...topicEntries(documents, input.tagSlugs), ...entries]
}

/**
 * The tag pages and series pages, built from the documents above them.
 *
 * Built from the already-filtered `documents` rather than from a second query,
 * which is what makes a topic page as public as its contents: a tag whose only
 * documents are drafts, future-dated, or `noindex` gets no URL here. That is
 * the conservative direction, and it is the same one the tag route takes — it
 * 404s on a slug with nothing behind it rather than rendering an empty page.
 *
 * A tag unknown to `tagSlugs` is skipped for the same reason. The caller builds
 * that map from the tags that have published content, so an unknown name means
 * a tag whose page does not exist, and inventing a URL for it would be
 * inventing a 404.
 */
function topicEntries(
  documents: readonly SeoDocument[],
  tagSlugs: ReadonlyMap<string, string> | undefined,
): MetadataRoute.Sitemap {
  const byTag = new Map<string, SeoDocument[]>()
  const bySeries = new Map<string, SeoDocument[]>()

  for (const doc of documents) {
    for (const name of new Set(tagNames(doc.tags))) {
      const group = byTag.get(name)
      if (group) group.push(doc)
      else byTag.set(name, [doc])
    }

    if (doc.series) {
      const group = bySeries.get(doc.series)
      if (group) group.push(doc)
      else bySeries.set(doc.series, [doc])
    }
  }

  const entries: MetadataRoute.Sitemap = []

  // Iterated in the map's own order rather than the documents', so the list
  // follows the tag list the site itself renders — most-used first — instead of
  // the order rows happened to come back in.
  for (const [name, slug] of tagSlugs ?? []) {
    const group = byTag.get(name)
    if (!group) continue

    entries.push({
      url: absoluteUrl(TOPIC_ROUTES.tag.path(slug)),
      lastModified: newestUpdate(group),
      changeFrequency: TOPIC_ROUTES.tag.changeFrequency,
      priority: TOPIC_ROUTES.tag.priority,
    })
  }

  // A series has no table to order it, so the names are sorted: a sitemap that
  // reorders itself between two crawls looks changed when it has not.
  for (const series of [...bySeries.keys()].sort()) {
    entries.push({
      url: absoluteUrl(TOPIC_ROUTES.series.path(series)),
      lastModified: newestUpdate(bySeries.get(series) ?? []),
      changeFrequency: TOPIC_ROUTES.series.changeFrequency,
      priority: TOPIC_ROUTES.series.priority,
    })
  }

  return entries
}
