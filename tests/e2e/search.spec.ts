import { expect, test, type Page } from '@playwright/test'

import { RATE_LIMITS } from '@/lib/auth/rate-limit-policy'

import { hasE2eDatabase } from './environment'
import { clearSearchLimits, showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * Search, from the two places a reader meets it.
 *
 * ## What this covers that the unit tests cannot
 *
 * `tests/unit/search.test.ts` proves the ranking — what a category is worth, how
 * a filter narrows — and `search-group.test.ts` proves the grouping rule. Both
 * are blind to the only surface where either one is met: the palette. What is
 * visible from here and nowhere else is that the headings are rendered in the
 * site's order *above* the ranked rows, that the arrow keys walk the flat list
 * across a group boundary, and that `Enter` opens the document the highlighted
 * row names. Each of those is a place where a correct payload still makes a
 * launcher that is wrong to use.
 *
 * It also carries the field this change added. A category is now indexed, shown
 * on both surfaces, and asserted here — and the search page renders the same
 * result set on the server, which is the entry point that works with JavaScript
 * switched off.
 *
 * ## Why the query is one token nothing else contains
 *
 * Every assertion below counts what this spec published. The suite deletes what
 * it creates (see `environment.ts`), but a run that fails partway does not, and a
 * query like "articles about linux" would then find last run's leftovers and
 * pass. A single alphanumeric token minted here, in the titles and the bodies of
 * two documents and nowhere else, cannot be matched by anything another run
 * wrote — so "2 results" is a figure this file put there.
 *
 * ## The one wait
 *
 * The local index is cached behind a five-second fingerprint of the content
 * tree, so a document published seconds ago can be one request late. The wait is
 * against `/api/search` rather than against either page, because what is being
 * waited for is the server's view of the corpus, not the browser's.
 *
 * ## The endpoint's own limit
 *
 * The last test is about the route rather than about either surface: search is
 * the one response on this site whose price is set by the caller, so the caller
 * is what `RATE_LIMITS.search` bounds. It is asserted here because the limiter
 * reads the request's address through the request context — which exists only
 * inside a request — and because the bucket it spends lives in the database this
 * suite already has.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

interface Fixture {
  type: 'post' | 'note'
  slug: string
  title: string
  body: string
  category?: string
}

/** The segment a type lives under, in the admin and on the public site alike. */
const SEGMENT: Record<Fixture['type'], string> = { post: 'posts', note: 'notes' }

/**
 * Create and publish one document, through the editor an author uses.
 *
 * Two kinds rather than two of the same kind, because two kinds is the smallest
 * corpus that can show a grouping — one group has nothing to be ordered against,
 * and a launcher that ignored `groupHits` entirely would still pass.
 */
async function publish(page: Page, document: Fixture): Promise<void> {
  const segment = SEGMENT[document.type]

  await page.goto(`/admin/${segment}/new`)
  await page.fill('#title', document.title)
  await page.fill('#slug', document.slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/${segment}/${document.slug}/edit`))

  await typeBody(page, document.body)
  await showMetadata(page)
  if (document.category) await page.fill('#fm-category', document.category)
  await page.selectOption('#fm-status', 'published')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
}

/** Delete one document from the list an author uses. */
async function remove(page: Page, document: Fixture): Promise<void> {
  await page.goto(`/admin/${SEGMENT[document.type]}`)
  await page
    .getByRole('row', { name: new RegExp(document.title) })
    .getByRole('button', { name: 'Delete' })
    .click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByText('Document deleted')).toBeVisible()
}

test('search finds two kinds of document, and says which is which', async ({ page }) => {
  const run = uniqueSlug()
  // One token, minted for this run and used nowhere else. Alphanumeric, because
  // the tokeniser splits on punctuation — `e2e-foo` is three terms, and a query
  // of three terms is a different question from the one this spec is asking.
  const term = `e2ekey${Date.now().toString(36)}`
  const category = `E2E Shelf ${run}`

  /*
   * The token is placed so that the ranking and the site's order *disagree*, and
   * that is the whole reason the two documents are written this way. The note
   * carries it in its title, which is the heaviest field in the index; the
   * article carries it only in its body, which is the lightest. So the note
   * outranks the article, and a palette that showed the ranked list would meet
   * the note first. Articles come first here because that is the site's order
   * and the grouping overrides the ranking — which is a claim a fixture where
   * both orders agreed could not test.
   */
  const article: Fixture = {
    type: 'post',
    slug: `${run}-article`,
    title: `E2E Article ${run}`,
    body: `A paragraph mentioning ${term}, filed on a shelf.`,
    category,
  }
  const note: Fixture = {
    type: 'note',
    slug: `${run}-note`,
    title: `E2E Note ${term}`,
    body: 'A shorter thought, kept current rather than published.',
  }

  await test.step('publishes an article and a note that share one token', async () => {
    await signIn(page)

    await publish(page, article)
    await publish(page, note)
  })

  await test.step('waits for the index both entry points read', async () => {
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/search?q=${term}&limit=20`)
          const body = (await response.json()) as { hits: unknown[] }
          // Exactly two. Not "at least one": a third hit would mean the token
          // was not unique to this run after all.
          return body.hits.length
        },
        { timeout: 20_000 },
      )
      .toBe(2)
  })

  await test.step('answers both documents on the search page, ranked and labelled', async () => {
    // The server-rendered half. It reads `?q=` during the render, so this is
    // also the assertion that the results are in the first HTML and every query
    // has a URL — the reason this page is not a client-side search box.
    await page.goto(`/search?q=${term}`)

    // Rank order, and this page has no headings to reorder it: the note matched
    // in its title, the heaviest field in the index, so it comes first. That is
    // the order the palette is *given*, and the palette puts the article first
    // anyway — which is what the step after this one shows, and why the two
    // documents are written the way they are.
    await expect(page.locator('article h2')).toHaveText([note.title, article.title])

    // A flat list has no headings to say what a result is, so each row says it —
    // and beside it the category, which is the field this change added to the
    // ranked index and to both renderings of a hit.
    const noteResult = page.locator('article').filter({ hasText: note.title })
    const articleResult = page.locator('article').filter({ hasText: article.title })

    await expect(noteResult.getByText('Note', { exact: true })).toBeVisible()
    await expect(articleResult.getByText('Article', { exact: true })).toBeVisible()
    await expect(articleResult.getByText(category)).toBeVisible()

    // Where the match landed, which is said only when it was not the title: the
    // article's row says it, the note's does not. The article's list is longer
    // than "body" because the body is also where the index derives a description
    // from when the frontmatter has none — so this asserts the line exists
    // rather than naming its contents, which are the index's business and not
    // this spec's.
    await expect(articleResult.getByText(/^matched in /)).toBeVisible()
    await expect(noteResult.getByText(/^matched in /)).toHaveCount(0)
  })

  await test.step('groups the palette by kind, in the site’s order', async () => {
    await page.goto('/')
    await page.keyboard.press('Control+k')

    const search = page.getByRole('combobox', { name: 'Search or run a command' })
    await expect(search).toBeVisible()
    await search.fill(term)

    const listbox = page.getByRole('listbox', { name: 'Results' })
    const articles = listbox.getByRole('group', { name: 'Articles' })
    const notes = listbox.getByRole('group', { name: 'Notes' })

    await expect(articles).toBeVisible()
    await expect(notes).toBeVisible()

    // One row under each heading, and then the rows in the order the arrow keys
    // will walk them. The search page just met the note first, because it scored
    // higher; here the article is first, because articles come first on this
    // site. Two orders, one surface apart, is the assertion that the grouping
    // *overrides* the ranking rather than happening to agree with it.
    await expect(articles.getByRole('option')).toHaveCount(1)
    await expect(notes.getByRole('option')).toHaveCount(1)

    const rows = listbox.getByRole('option')
    await expect(rows.nth(0)).toContainText(article.title)
    await expect(rows.nth(1)).toContainText(note.title)

    // The row no longer repeats the heading — "Article" beside every article —
    // and says the shelf instead. Same field the search page shows.
    await expect(rows.nth(0)).toContainText(category)
  })

  await test.step('walks the groups with the arrow keys and opens what is highlighted', async () => {
    const search = page.getByRole('combobox', { name: 'Search or run a command' })
    const rows = page.getByRole('listbox', { name: 'Results' }).getByRole('option')

    // Typing resets the highlight to the top, so the row under the keyboard is
    // never one left over from the previous query.
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')

    // One press crosses a group boundary — the heading above the second row is
    // "Notes" — and the highlight keeps going. A list that stopped at the end of
    // each group would need a second interaction nobody knows about.
    await search.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')

    await search.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/notes/${note.slug}$`))
    await expect(page.getByRole('heading', { level: 1, name: note.title })).toBeVisible()
  })

  await test.step('runs a command from the same input, without closing the launcher', async () => {
    await page.goto('/')
    await page.keyboard.press('Control+k')

    const search = page.getByRole('combobox', { name: 'Search or run a command' })
    await search.fill('>theme')

    const listbox = page.getByRole('listbox', { name: 'Commands' })
    await expect(listbox.getByRole('group', { name: 'Commands' })).toBeVisible()

    const rows = listbox.getByRole('option')
    // The three theme commands and nothing else: `>theme` is a filter over the
    // commands, and the `>` is what made this input stop being a search.
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Theme: light')

    await search.press('ArrowDown')
    await search.press('Enter')

    await expect(page.locator('html')).toHaveClass(/dark/)

    // And it stayed open, which is the documented behaviour of the theme
    // commands: a reader comparing the two would otherwise have to reopen the
    // palette after each one.
    await expect(listbox).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('deletes what it published', async () => {
    await remove(page, article)
    await remove(page, note)
  })
})

test('stops answering a caller who has spent its searches, and says when to come back', async ({
  request,
}) => {
  const url = '/api/search?q=e2elimit&limit=1'

  await clearSearchLimits()

  const startedAt = Date.now()

  /*
   * The whole allowance at once, and the capacity is imported rather than
   * written here so the two cannot drift.
   *
   * The HTTP burst can take longer than one refill interval on a loaded host.
   * Refills are valid admissions, so exhaustion below accounts for elapsed time
   * rather than assuming the first request after the capacity must be refused.
   */
  const burst = await Promise.all(
    Array.from({ length: RATE_LIMITS.search.capacity }, () => request.get(url)),
  )

  for (const [index, response] of burst.entries()) {
    expect(response.status(), `request ${index + 1} of the allowance`).toBe(200)
  }

  let requestsSent = burst.length
  let refused = await request.get(url)
  requestsSent += 1
  for (let round = 0; refused.status() === 200 && round < 3; round += 1) {
    const refilled = Math.ceil((Date.now() - startedAt) / 1000 * RATE_LIMITS.search.refillPerSecond)
    const extra = Math.max(2, RATE_LIMITS.search.capacity + refilled + 2 - requestsSent)
    const responses = await Promise.all(Array.from({ length: extra }, () => request.get(url)))
    requestsSent += extra
    for (const response of responses) expect([200, 429]).toContain(response.status())
    refused = responses.find((response) => response.status() === 429) ?? responses[responses.length - 1]!
  }
  expect(refused.status(), `${requestsSent} searches in ${Date.now() - startedAt}ms`).toBe(429)

  // What a client can act on, and what the palette shows the reader: a wait,
  // named, rather than a search that is broken.
  const seconds = Number(refused.headers()['retry-after'])
  expect(seconds).toBeGreaterThan(0)
  const body = (await refused.json()) as { error?: string }
  expect(body.error).toContain('Too many searches')
  expect(body.error).toContain(String(seconds))

  // A refusal is about the bucket rather than about the caller: with the
  // allowance back, the same request is answered again.
  await clearSearchLimits()
  expect((await request.get(url)).status()).toBe(200)
})
