import { expect, test, type APIResponse } from '@playwright/test'
import { Client } from 'pg'

import { E2E_PORT, e2eDatabaseUrl } from './environment'

/**
 * Page views, from both ends of the wire.
 *
 * ## The two halves, and why they are two tests
 *
 * `assertProductionPosture` refuses to start on an `http://` site URL, so the
 * server this suite runs is configured `SITE_URL=https://127.0.0.1:3100` while
 * the browser that tests it speaks `http://127.0.0.1:3100`. The collector
 * decides whether a beacon is same-origin by comparing protocols — the right
 * check, and one this suite is not a reason to weaken — so a beacon sent by the
 * browser is a view of another scheme and is dropped. No row, no cookie.
 *
 * That is not a defect to work around and nothing here pretends otherwise. It
 * splits the feature down a seam that was always there:
 *
 * - **The browser half** is what a real browser does and no other test can
 *   check: that a view is reported when the reader leaves a page and not when
 *   they arrive at one, that the client-side navigation ending almost every view
 *   is one of the moments that reports, and that what arrives is one beacon per
 *   view naming the right page. `sendBeacon`, hydration and React's effect
 *   cleanup are all in the path, and all three are things a unit test has to
 *   pretend about.
 * - **The server half** is a request presenting the referer a reader of the
 *   https deployment would present, which is the only kind of beacon the
 *   deployment can accept. It exercises the deployed route, the collector's
 *   rules, the cookie and the write — the same code the browser would have
 *   reached had the two schemes matched.
 *
 * ## What the first test cannot assert, and where it is asserted instead
 *
 * Not the beacon's body. `sendBeacon` sends a `Blob`, and Chromium hands
 * Playwright no data for it — `postData()` and `postDataBuffer()` are both
 * null, which the handler below documents rather than papers over. So the
 * payload's *contents* are checked where each half of them can be:
 * `tests/unit/analytics.test.ts` parses every payload the client can construct
 * with the server's own schema, and the second test below shows the server
 * refusing a payload that tries to name the page it came from.
 */

/** Where the beacon is sent. One endpoint, both tests. */
const BEACON_PATH = '/api/analytics'

/** The origin the deployment under test believes it is served from. */
const SITE_ORIGIN = `https://127.0.0.1:${E2E_PORT}`

/** A path with no trailing slash, so a beacon's referer names a real page. */
const PAGE_PATH = '/posts'

/**
 * A path a forged beacon tries to claim, which no row may ever carry.
 *
 * Distinctive on purpose: if the leniency this asserts against ever crept in,
 * the failure would name this string rather than looking like an off-by-one.
 */
const FORGED_PATH = '/an-article-of-my-choosing'

/**
 * A desktop browser's user agent, sent by hand in the request-level test.
 *
 * Written out rather than taken from a constant so that the device class it is
 * expected to produce is visible next to it — `desktop` is asserted below, and
 * the assertion is the point: which class a beacon lands in is decided from
 * this header and from nothing else.
 */
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/** The one header a beacon's answer may carry, or `undefined` if it carries none. */
function setCookie(response: APIResponse): string | undefined {
  return response
    .headersArray()
    .find((header) => header.name.toLowerCase() === 'set-cookie')?.value
}

test('a view is reported as the reader leaves it, naming the page they left', async ({
  page,
}) => {
  /**
   * Every beacon, as the one header that says which page it is about.
   *
   * `pagehide` beacons are not in here and cannot be: Chromium hands a request
   * that outlives its document to the browser process, where Playwright does not
   * follow it. They are delivered — that was checked against the server's own
   * view of the requests rather than through the harness — but a test asserting
   * on them would be asserting on Playwright. Both views below are therefore
   * ended by the moment *before* the URL changes, which is the report this test
   * is about.
   */
  const sent: { referer: string; method: string; contentType: string | undefined }[] = []
  const answered: number[] = []

  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== BEACON_PATH) return
    sent.push({
      referer: request.headers()['referer'] ?? '',
      method: request.method(),
      contentType: request.headers()['content-type'],
    })
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== BEACON_PATH) return
    answered.push(response.status())
  })

  /*
   * The footer's sections, specifically. The header carries a nav of the same
   * accessible name — both are the site's sections — and on a wide viewport
   * both are on the page, so an unscoped query matches two elements. The footer
   * is also the one that exists on every viewport: the header's is hidden below
   * its breakpoint, and this test runs on both projects.
   */
  const sections = page.getByRole('contentinfo').getByRole('navigation', { name: 'Sections' })

  await page.goto('/')
  await expect(sections).toBeVisible()

  // Nothing has been sent yet, and this is the half of the contract that is
  // easy to get wrong in the other direction: a beacon that reported on mount
  // would count every prefetch and every reader who bounced before reading.
  // (`/` is also where the router republishes the URL it is already on, which is
  // not a navigation and must not be mistaken for one.)
  expect(sent).toHaveLength(0)

  /*
   * The reader clicks through to another page of the same site. Nothing is
   * unloaded and the layout is not remounted: the URL is rewritten in place, so
   * this is the navigation that ends most views and the one no unload event ever
   * announces.
   */
  await sections.getByRole('link', { name: 'Archive', exact: true }).click()
  await expect(page).toHaveURL(/\/archive$/)
  await expect.poll(() => sent.length).toBe(1)

  /*
   * Then they click the feed, which is the one link in the footer that is a
   * plain anchor rather than a route of the app — a document navigation, and the
   * other way a view ends.
   */
  await page
    .getByRole('contentinfo')
    .getByRole('navigation', { name: 'Elsewhere' })
    .getByRole('link', { name: 'RSS', exact: true })
    .click()
  await page.waitForURL(/\/rss\.xml$/)
  await expect.poll(() => sent.length).toBe(2)

  /*
   * One beacon per view, in the order the reader made them, each naming the page
   * it is about — which is the whole assertion.
   *
   * The referer is the only way the server knows which page was viewed: the body
   * carries no path and could not be trusted with one, and the browser sets the
   * header from whatever is in the address bar at the moment the beacon is sent.
   * So the first view must name `/`, not the `/archive` the reader went to, and
   * the second must name `/archive`. Reported one moment later — from React's
   * cleanup, as this component first did — both would name the page the reader
   * arrived at, and `['/archive', '/rss.xml']` is the failure this test exists
   * to catch.
   */
  expect(sent.map((beacon) => new URL(beacon.referer).pathname)).toEqual(['/', '/archive'])
  expect(sent.map((beacon) => `${beacon.method} ${beacon.contentType ?? ''}`)).toEqual([
    'POST application/json',
    'POST application/json',
  ])

  /*
   * Fire and forget: the page is never told anything it could act on, and a
   * dropped beacon is an expected outcome rather than an error status. The
   * answer to the first is observable and is the 204 the route promises; the
   * second comes back after the document that sent it is gone, so Playwright
   * reports it no more than it reported the request — the same limitation as the
   * unload beacon noted above, one step earlier in the sequence.
   */
  await expect.poll(() => answered.length).toBeGreaterThanOrEqual(1)
  expect(answered.every((status) => status === 204)).toBe(true)
})

test('a beacon the deployment accepts is recorded, and one it does not leaves nothing', async ({
  request,
}) => {
  const client = new Client({ connectionString: e2eDatabaseUrl() })
  await client.connect()

  /** What the collector wrote, read from the table rather than through the admin. */
  const rows = async (): Promise<
    {
      path: string
      referrer_domain: string
      device: string
      navigation_type: string
      duration_ms: number
      visitor_hash: string
    }[]
  > => {
    const result = await client.query(
      `SELECT path, referrer_domain, device, navigation_type, duration_ms, visitor_hash
         FROM analytics_events WHERE path = $1 ORDER BY id`,
      [PAGE_PATH],
    )
    return result.rows
  }

  /** How many rows exist for a path, whatever wrote them. */
  const rowsAt = async (path: string): Promise<number> => {
    const result = await client.query(
      'SELECT count(*)::int AS n FROM analytics_events WHERE path = $1',
      [path],
    )
    return result.rows[0].n
  }

  const forget = () =>
    client.query('DELETE FROM analytics_events WHERE path = ANY($1)', [
      [PAGE_PATH, FORGED_PATH],
    ])

  try {
    await forget()

    // The referer a reader of this deployment would send: the deployment's own
    // https origin and the path of the page they were reading. The path is the
    // server's to derive, never the client's to name — the body below carries no
    // path and could not be trusted with one, and the row still has one.
    const headers = { referer: `${SITE_ORIGIN}${PAGE_PATH}`, 'user-agent': DESKTOP_UA }

    const first = await request.post(BEACON_PATH, {
      headers,
      data: {
        durationMs: 4200,
        referrer: 'https://news.example.com/an-article',
        navigationType: 'navigate',
      },
    })

    expect(first.status()).toBe(204)

    // The reader's identity, minted here and nowhere else: a random value in a
    // first-party cookie, readable by no script on the page.
    const cookie = setCookie(first)
    expect(cookie).toMatch(/^myblog_vid=[0-9a-f]{32};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toMatch(/Max-Age=\d+/)

    const visitor = /^myblog_vid=([0-9a-f]{32})/.exec(cookie!)![1]

    // The same reader, one page later. Same cookie, so the same visitor — and
    // no second cookie, because an identity already established is not reminted.
    const second = await request.post(BEACON_PATH, {
      headers: { ...headers, cookie: `myblog_vid=${visitor}` },
      data: { durationMs: 1000, navigationType: 'navigate' },
    })

    expect(second.status()).toBe(204)
    expect(setCookie(second)).toBeUndefined()

    const recorded = await rows()
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({
      path: PAGE_PATH,
      referrer_domain: 'news.example.com',
      device: 'desktop',
      navigation_type: 'navigate',
      duration_ms: 4200,
    })
    // No referrer in the second beacon, and the column holds that as an empty
    // string rather than as a host that was never sent.
    expect(recorded[1]).toMatchObject({ referrer_domain: '', duration_ms: 1000 })

    // Two views, one visitor: the stored hash is derived from the cookie and the
    // day, so it identifies a reader for a day and cannot follow them past it.
    expect(recorded[0]!.visitor_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(recorded[1]!.visitor_hash).toBe(recorded[0]!.visitor_hash)

    /*
     * A client that names the page it is reporting.
     *
     * The path is derived from the referer and never supplied by the caller, and
     * the beacon contract is a strict object — so a payload with a `path` in it
     * is not a beacon at all. This is where that is enforced end to end; the
     * other half of it, that the client never sends one, is checked against the
     * same schema in the unit suite.
     */
    const forged = await request.post(BEACON_PATH, {
      headers,
      data: { durationMs: 3000, path: FORGED_PATH },
    })

    expect(forged.status()).toBe(204)
    expect(setCookie(forged)).toBeUndefined()
    expect(await rowsAt(FORGED_PATH)).toBe(0)
    expect(await rows()).toHaveLength(2)

    /*
     * Two beacons the deployment refuses, answered the same way.
     *
     * A referer naming another site means the request did not come from one of
     * our pages, and a crawler is not a reader. Neither is an error: a beacon is
     * fire-and-forget, the client cannot act on the answer, and a drop is the
     * documented outcome for every reason a view does not count.
     */
    const foreign = await request.post(BEACON_PATH, {
      headers: { referer: 'https://news.example.com/an-article', 'user-agent': DESKTOP_UA },
      data: { durationMs: 5000 },
    })
    expect(foreign.status()).toBe(204)
    expect(setCookie(foreign)).toBeUndefined()

    const crawler = await request.post(BEACON_PATH, {
      headers: {
        referer: `${SITE_ORIGIN}${PAGE_PATH}`,
        'user-agent':
          'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      },
      data: { durationMs: 10 },
    })
    expect(crawler.status()).toBe(204)
    expect(setCookie(crawler)).toBeUndefined()

    // A dropped beacon mints no identity either, so none of the three above left
    // a row or a cookie behind.
    expect(await rows()).toHaveLength(2)
  } finally {
    await forget()
    await client.end()
  }
})
