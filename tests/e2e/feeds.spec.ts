import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { E2E_PORT, hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The feeds a topic publishes.
 *
 * `/rss.xml` has existed for a while; `/rss/<tag>.xml` and
 * `/rss/category/<category>.xml` are addressed by a *suffix inside a dynamic
 * segment*, which is the part of these routes a unit test cannot be sure of.
 * Nothing in the app router says that `[tag]` matches a segment ending in
 * `.xml` any differently from one that does not, and a route that silently
 * never matched would answer every one of these URLs with Next's own 404 — a
 * page that looks like a 404 and is not this site's. So the assertions here are
 * mostly about the address: that the URL is reached at all, that what comes
 * back is a feed, and that it carries the document filed under that topic and
 * nothing else from the site.
 *
 * The document is written through the admin, as an author would. A fixture
 * inserted into the index directly would prove the feed reads a table; this
 * proves the path from a saved Markdown file to a subscriber's reader, which is
 * the thing that has to work.
 */

/** The origin the deployment under test believes it is served from. */
const SITE_ORIGIN = `https://127.0.0.1:${E2E_PORT}`

/** The one answer this site gives for a feed address with no feed behind it. */
const NO_FEED = 'No feed is served at this address.'

/** An XML document from an address — a feed or the sitemap — with its status. */
async function fetchXml(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const response = await request.get(path)
  return {
    status: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    body: await response.text(),
  }
}

/** The `<item>` elements of an RSS document. */
function items(xml: string): string[] {
  return xml.match(/<item>[\s\S]*?<\/item>/g) ?? []
}

/**
 * The feed a page advertises — the `alternate` link in its head, as a path.
 *
 * Read from the rendered page rather than rebuilt from the slug, because the
 * question is not whether this test can construct the right URL. It is whether
 * the page a reader is on points at a feed that exists.
 *
 * The path rather than the whole URL, so the caller can fetch it: the
 * deployment under test is configured `https://` while the browser and this
 * request context speak `http://` (see `analytics.spec.ts`), and the origin is
 * asserted here instead.
 */
async function advertisedFeed(page: Page, path: string): Promise<string> {
  await page.goto(path)
  const href = await page
    .locator('link[rel="alternate"][type="application/rss+xml"]')
    .getAttribute('href')

  expect(href, `${path} advertises no feed`).toBeTruthy()

  // Absolute, and on the origin the deployment believes it is served from. A
  // relative `href` is legal HTML and useless to the reader that matters: the
  // one whose aggregator was handed the page rather than shown it.
  const url = new URL(href!)
  expect(url.origin, path).toBe(SITE_ORIGIN)
  return url.pathname
}

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a topic is served as a feed of its own, and the page says where', async ({
  page,
  request,
}) => {
  const slug = uniqueSlug()
  const title = `E2E Feed Post ${slug}`
  // Distinctive and stable: the tag slug comes from the name, and a name that
  // slugifies to itself keeps the URL this test asks for the one the site
  // serves. The category is deliberately *not* slug-shaped — it has a space and
  // capitals, which is what an author writes, and it is the case that decides
  // whether the segment arrives percent-encoded.
  const tag = `feed-${slug}`
  const category = `E2E Feed ${slug}`

  await test.step('writes and publishes a post under a tag and a category', async () => {
    await signIn(page)
    await page.goto('/admin/posts/new')
    await page.fill('#title', title)
    await page.fill('#slug', slug)
    await page.selectOption('#status', 'draft')
    await page.getByRole('button', { name: 'Create and edit' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))

    await typeBody(page, `A post written to be read through a feed.\n`)

    await showMetadata(page)
    await page.fill('#fm-tags', tag)
    await page.fill('#fm-category', category)
    await page.selectOption('#fm-status', 'published')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/Saved to file/)).toBeVisible()
  })

  await test.step('serves the tag as an RSS feed', async () => {
    const feed = await fetchXml(request, `/rss/${tag}.xml`)

    expect(feed.status).toBe(200)
    expect(feed.contentType).toContain('application/rss+xml')
    expect(feed.body).toContain(`<title>#${tag}`)
    expect(feed.body).toContain(
      `<atom:link href="${SITE_ORIGIN}/rss/${tag}.xml" rel="self" type="application/rss+xml"/>`,
    )

    // One item, and it is this post. A feed that quietly carried the whole site
    // would still contain the title this test looks for, so the count is the
    // assertion that says the feed was cut by topic.
    const entries = items(feed.body)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(title)
    expect(entries[0]).toContain(`${SITE_ORIGIN}/posts/${slug}`)
  })

  await test.step('lists the post, and the tag page it created, in the sitemap', async () => {
    const sitemap = await fetchXml(request, '/sitemap.xml')

    expect(sitemap.status).toBe(200)
    expect(sitemap.contentType).toContain('xml')
    expect(sitemap.body).toContain(`${SITE_ORIGIN}/posts/${slug}`)

    // The tag page is the part of this the sitemap could not see before: the
    // document list carries tag *names*, while the page is addressed by a slug
    // that only the tags table knows. A tag whose only document is a draft has
    // no page, and a sitemap that guessed the slug from the name would list one
    // that 404s.
    expect(sitemap.body).toContain(`${SITE_ORIGIN}/tags/${tag}`)
  })

  await test.step('serves the category as a feed too', async () => {
    const path = `/rss/category/${encodeURIComponent(category)}.xml`
    const feed = await fetchXml(request, path)

    expect(feed.status).toBe(200)
    expect(feed.contentType).toContain('application/rss+xml')
    expect(feed.body).toContain(
      `<atom:link href="${SITE_ORIGIN}${path}" rel="self" type="application/rss+xml"/>`,
    )

    const entries = items(feed.body)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(title)
  })

  await test.step('matches a category as it is written, not case-insensitively', async () => {
    // The same category, lower-cased. One category has to have one feed URL —
    // `atom:link rel="self"` can only name one — so a forgiving comparison
    // would put two addresses in circulation for the same feed.
    const lower = await fetchXml(
      request,
      `/rss/category/${encodeURIComponent(category.toLowerCase())}.xml`,
    )
    expect(lower.status).toBe(404)
    expect(lower.body).toContain(NO_FEED)
  })

  await test.step('advertises the tag feed from the tag page', async () => {
    const href = await advertisedFeed(page, `/tags/${tag}`)

    // Followed rather than compared against a string this test built: the
    // failure being guarded against is a page advertising a URL no route
    // serves, and only the request can tell the two apart.
    const feed = await fetchXml(request, href)
    expect(feed.status).toBe(200)
    expect(items(feed.body)).toHaveLength(1)
  })

  await test.step('advertises the site feed from a page that is not about a topic', async () => {
    // Every page states its own alternates — the root layout's are replaced by
    // the first page that sets the key, so a site feed advertised only there
    // reaches the home page and nothing else. `/posts` is one of the pages that
    // has to carry it.
    expect(await advertisedFeed(page, '/posts')).toBe('/rss.xml')
    expect(await advertisedFeed(page, '/')).toBe('/rss.xml')
  })

  await test.step('answers a topic with nothing behind it as no feed at all', async () => {
    for (const path of [
      `/rss/no-such-tag-${slug}.xml`,
      `/rss/category/${encodeURIComponent(`no-such-category-${slug}`)}.xml`,
      // Not a feed address: no `.xml` suffix. A 404 here is also what proves
      // the two above were answered by this site's routes rather than by the
      // router having failed to match them — Next's own 404 has an HTML body.
      `/rss/${tag}`,
      '/rss/category',
    ]) {
      const answer = await fetchXml(request, path)
      expect(answer.status, path).toBe(404)
      expect(answer.body, path).toContain(NO_FEED)
      expect(answer.contentType, path).toContain('text/plain')
    }
  })

  await test.step('deletes the post', async () => {
    await page.goto('/admin/posts')
    const row = page.getByRole('row', { name: new RegExp(title) })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()

    // The toast, not the disappearing row, is what says the delete happened.
    // The confirmation is modal, so the row is hidden from the accessibility
    // tree the moment the dialog opens — a `toBeHidden()` check here would pass
    // while the action was still running, and the assertions below are about
    // the server's view, which is only settled once the action has returned.
    await expect(page.getByText('Document deleted')).toBeVisible()
    await expect(row).toBeHidden()
  })

  await test.step('stops listing the deleted post, and its tag page, in the sitemap', async () => {
    // The same rule that 404s the feed: a tag page exists only while something
    // is published under it. Asking a crawler to fetch either one now would be
    // asking it to record a 404.
    const sitemap = await fetchXml(request, '/sitemap.xml')

    expect(sitemap.body).not.toContain(`${SITE_ORIGIN}/posts/${slug}`)
    expect(sitemap.body).not.toContain(`${SITE_ORIGIN}/tags/${tag}`)
  })

  await test.step('stops serving the topic feed when nothing is behind it', async () => {
    // The tag row outlives the document, and `getTag` only returns a tag with
    // published content behind it — so the page 404s and the feed does too,
    // rather than turning into a feed of nothing.
    const feed = await fetchXml(request, `/rss/${tag}.xml`)
    expect(feed.status).toBe(404)
    expect(feed.body).toContain(NO_FEED)
  })
})
