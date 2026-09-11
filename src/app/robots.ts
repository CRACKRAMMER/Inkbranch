import type { MetadataRoute } from 'next'

import { buildRobots } from '@/lib/seo/robots'

/**
 * robots.txt.
 *
 * The rules themselves live in `@/lib/seo/robots`, where `DISALLOWED_PATHS` and
 * `ALLOWED_PATHS` are named exports the tests assert against. Re-stating them
 * here — or worse, hand-writing the file — would be a second copy of the one
 * list on this site that must not drift: a disallow entry that exists in the
 * module but not in the served file is an invitation to index the login form.
 *
 * Static, and safe to be: `buildRobots()` reads `SITE_URL` and nothing else.
 */
export default function robots(): MetadataRoute.Robots {
  return buildRobots()
}
