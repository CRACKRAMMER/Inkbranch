import type { MetadataRoute } from 'next'
import { documentUrl } from '@/lib/content/paths'
import type { ContentType } from '@/lib/content/schema'
import {
  absoluteUrl,
  effectivePublishedAt,
  isPublic,
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
 * Individual tag and series pages are absent too, and that is a real gap
 * rather than a decision: this list is built from `SeoDocument`s, which carry
 * tag *names* and not the slugs those pages are addressed by. Closing it means
 * threading the tag list through `SitemapInput`, which is worth doing and has
 * not been.
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

export interface SitemapInput {
  documents: readonly SeoDocument[]
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

  return [...pages, ...entries]
}
