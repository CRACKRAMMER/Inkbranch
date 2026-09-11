import { expect, test } from '@playwright/test'

import { E2E_PORT, hasE2eDatabase } from './environment'
import { jsonLdNodeOfType, jsonLdNodes } from './support'

/**
 * What the site says about itself, to something that is not a browser.
 *
 * A page's structured data is the one thing about it that no reader checks and
 * no developer sees. It is also the part with the widest failure mode: a script
 * that stops being rendered, a `@type` that a refactor renamed, a search action
 * left pointing at an endpoint that has since been turned off — all of them
 * leave a page that looks perfect and a machine that reads nothing, which is
 * the kind of defect that is discovered in a search console months later.
 *
 * ## Why the home page and not all of them
 *
 * The per-document nodes are asserted where the documents are: the article's
 * `BlogPosting` in `authoring.spec.ts`, the `Person` in `about.spec.ts`. What
 * is left is the node that belongs to no document — the site's own — and the
 * home page is the only place it can be.
 *
 * No sign-in and no fixtures: the seed gives the site its name, and everything
 * asserted here is on a page anyone can load.
 */

/** The origin the deployment under test believes it is served from. */
const SITE_ORIGIN = `https://127.0.0.1:${E2E_PORT}`

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('the home page describes the site and offers the search a crawler can use', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)

  // One `WebSite` node, and the helper fails the test if there is none or more
  // than one — the failure mode this guards against is a second copy from a
  // layout, which a `first()` would hide.
  const site = jsonLdNodeOfType(await jsonLdNodes(page), 'WebSite')

  expect(typeof site.name).toBe('string')
  expect(site.name).not.toBe('')
  expect(site.url).toBe(`${SITE_ORIGIN}/`)

  /*
   * The search action, and its template.
   *
   * `{?q}` is not a typo for `?q`: the URL template is RFC 6570, and the braced
   * form is what tells a consumer that the query is optional and where it goes.
   * A site that emits the plain form gets a search box that does not work, so
   * the exact template is asserted rather than the presence of the field.
   *
   * The endpoint is `/search` — the page a reader would use — rather than the
   * API the command palette calls, because the promise a sitelinks search box
   * makes is to a person, and it should land on the page that renders results
   * without JavaScript and gives every query a URL.
   */
  expect(site.potentialAction).toMatchObject({
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${SITE_ORIGIN}/search{?q}` },
    'query-input': 'required name=q',
  })
})
