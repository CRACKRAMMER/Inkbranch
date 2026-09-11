import type { MetadataRoute } from 'next'
import { siteOrigin } from '@/env'

/**
 * robots.txt.
 *
 * The disallow list is short and every entry is deliberate. Getting this file
 * wrong is not a subtle failure: a robots.txt that allows `/admin` invites a
 * crawler to index the login form and the editor, and once those URLs are in an
 * index, removing them takes months. The rules are exported so the test can
 * assert them by name rather than by grepping the generated text.
 */

/**
 * Prefixes crawlers must not fetch.
 *
 * `/admin` has no trailing slash on purpose: the prefix match then covers
 * `/admin` itself, which is the login page, as well as everything under it.
 * `/api/` and `/preview/` keep theirs because the directories themselves are
 * not routes — there is no page at `/api`.
 *
 * `/preview/` is the one entry with nothing behind it today: previews are
 * served from `/api/preview` and already covered by `/api/`. It stays because a
 * draft preview is the single most damaging thing to leak — it is unfinished
 * content at a URL that is not linked from anywhere — and the cost of the extra
 * line is nothing if that route is ever moved out from under `/api`.
 */
export const DISALLOWED_PATHS: readonly string[] = [
  '/admin',
  '/api/',
  '/preview/',
]

/** Public routes are allowed explicitly, so the intent survives an edit. */
export const ALLOWED_PATHS: readonly string[] = ['/']

export function buildRobots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [...ALLOWED_PATHS],
        disallow: [...DISALLOWED_PATHS],
      },
    ],
    // Absolute, because a robots.txt at a subpath would resolve a relative
    // sitemap reference against that subpath.
    sitemap: `${siteOrigin}/sitemap.xml`,
    host: siteOrigin,
  }
}
