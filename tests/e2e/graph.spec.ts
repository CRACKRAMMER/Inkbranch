import { expect, test, type Locator, type Page } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The graph, as a reader sees it.
 *
 * ## What this covers that the unit tests cannot
 *
 * `tests/unit/graph.test.ts` proves the rules — which nodes are selected, how a
 * tag's degree is counted, what an edge points at — and none of that is visible
 * from here. What is visible from here is the wiring: the page fetches
 * `/api/graph` after it mounts, the toolbar counts what came back, the filters
 * re-index the edges in the browser, and the list carries the same nodes the
 * canvas draws. Each of those is a place where a correct payload gets rendered
 * wrong, and the canvas is what makes such a mistake invisible — a graph drawn
 * without its tag layer is still a graph.
 *
 * ## Why the assertions are exact
 *
 * Every spec that publishes also deletes — see `environment.ts` for why the
 * suite is built that way — so the two documents this spec publishes are the
 * whole corpus, and every figure the page reports is a figure this file put
 * there. An assertion of the form
 * "at least one tag" would pass on a graph that had picked up a neighbour, which
 * is the failure this file exists to notice.
 *
 * ## The one wait
 *
 * The relations index behind `/api/graph` is a cache with a five-second
 * fingerprint check, so a document published seconds ago can be one request
 * late. The spec waits that out against the endpoint itself rather than against
 * the page, because what is being waited for is the server's view of the corpus
 * and not the browser's.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

/**
 * Create and publish one document, through the editor an author uses.
 *
 * The wiki link is written as the author writes it — `[[slug]]` — rather than as
 * a path, because resolving it is the interesting half: the edge on the graph
 * exists only if the link table resolved a reference that names a document the
 * writer never had a URL for.
 *
 * It also means the link is published *before* the document it names, which is
 * the harder order and the one worth driving through a browser. A save resolves
 * the links in the document being saved against the index as it stands, so this
 * reference is written as a row with no target — and it becomes an edge only
 * because the save that follows resolves the links pointing *at* the document it
 * is saving. That second half is invisible from the unit tests, which call the
 * sync engine directly; here it is what the browser ends up drawing.
 */
async function publish(
  page: Page,
  document: { slug: string; title: string; body: string; tag: string },
): Promise<void> {
  await page.goto('/admin/posts/new')
  await page.fill('#title', document.title)
  await page.fill('#slug', document.slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${document.slug}/edit`))

  await typeBody(page, document.body)
  await showMetadata(page)
  await page.fill('#fm-tags', document.tag)
  await page.selectOption('#fm-status', 'published')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
}

/** The figure a row leads with — the same number a reader reads off it. */
function degreeOf(list: Locator, title: string): Locator {
  return list
    .getByRole('link', { name: title })
    .locator('xpath=ancestor::li[1]')
    .locator('span')
    .last()
}

test('the graph draws the documents, their link, and the tag they share', async ({ page }) => {
  const run = uniqueSlug()
  const tagName = `E2E Topic ${run}`
  const alpha = { slug: `${run}-alpha`, title: `E2E Alpha ${run}` }
  const beta = { slug: `${run}-beta`, title: `E2E Beta ${run}` }

  const alphaLink = (list: Locator) => list.getByRole('link', { name: alpha.title })
  const betaLink = (list: Locator) => list.getByRole('link', { name: beta.title })

  await test.step('publishes a document that links forward, then the one it names', async () => {
    await signIn(page)

    // Beta first, naming a document that does not exist yet. This is the order
    // an author writes in — the note that follows on from something before the
    // something is finished — and the one that used to leave the graph without
    // an edge.
    await publish(page, {
      ...beta,
      body: `The second half, following on from [[${alpha.slug}]].`,
      tag: tagName,
    })
    await publish(page, { ...alpha, body: 'The first half of the pair.', tag: tagName })
  })

  await test.step('waits for the index the page is drawn from to catch up', async () => {
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/graph?limit=250')
          const graph = (await response.json()) as { nodes: { type: string }[] }
          // Two documents and one tag. Not "at least three": a fourth node would
          // mean this spec is drawing something another spec left behind.
          return graph.nodes.length
        },
        { timeout: 20_000 },
      )
      .toBe(3)
  })

  await test.step('counts the nodes it is showing, by kind', async () => {
    await page.goto('/graph')

    // Two documents, and the one tag they have in common. The figures are the
    // page's own count of the payload, so this is also the assertion that the
    // tag layer arrived at all.
    await expect(page.getByText('2 documents · 1 tag')).toBeVisible()
    await expect(page.locator('canvas')).toBeVisible()
  })

  await test.step('lists every node the canvas draws, and marks the tag as a tag', async () => {
    // The list is the accessible half of the page — the canvas is `aria-hidden`
    // — so this is a keyboard user's graph, and it has to hold the same nodes.
    const list = page.getByRole('region', { name: '3 nodes in this view' })

    await expect(alphaLink(list)).toBeVisible()
    await expect(betaLink(list)).toBeVisible()

    const tag = list.getByRole('link', { name: tagName })
    await expect(tag).toBeVisible()
    // The name from the tag table, not the slug the URL is built from: the page
    // this link opens is headed with the name.
    await expect(tag).toHaveAttribute('href', /^\/tags\/.+/)
    // And it is marked, because a topic listed among documents reads as one.
    await expect(list.getByText('Tag', { exact: true })).toBeVisible()

    // One connection each, and that is the interesting half: only beta has a
    // link written in it, so a figure of 1 beside alpha is the backlink being
    // counted — which is what makes this a graph of the two rather than of the
    // one. Alpha was published last, so its figure is the whole of what this
    // spec is here to prove: the link was written before there was anything to
    // point at. The tag is carried by both, and is as big as that. These are the
    // figures the drawn graph sizes its nodes by, read where a reader can check
    // them by counting.
    await expect(degreeOf(list, alpha.title)).toHaveText('1')
    await expect(degreeOf(list, beta.title)).toHaveText('1')
    await expect(degreeOf(list, tagName)).toHaveText('2')
  })

  await test.step('narrows to one kind of node, and counts only that kind', async () => {
    // A checkbox list of what to show, not what to hide: an empty selection is
    // the whole graph, and checking Articles is how a reader asks for the
    // documents without the topics.
    await page.getByRole('checkbox', { name: 'Articles' }).check()

    // The heading says what is in the list, so this one assertion is the tag
    // leaving and the documents staying.
    const list = page.getByRole('region', { name: '2 nodes in this view' })
    await expect(alphaLink(list)).toBeVisible()
    await expect(betaLink(list)).toBeVisible()
    await expect(list.getByRole('link', { name: tagName })).toHaveCount(0)

    // Exactly "2 documents", with no tag clause: the summary describes the view
    // and there are no tags in this one. "2 documents · 0 tags" would be a
    // figure about a filter the reader set themselves.
    await expect(page.getByText('2 documents', { exact: true })).toBeVisible()

    // The connections are the documents' own — tags are not counted towards
    // them — so dropping the tag cannot change what these two are worth.
    await expect(degreeOf(list, alpha.title)).toHaveText('1')

    // And the tag alone, which is the other direction: same control, and the
    // list is now the one node that is not a document.
    await page.getByRole('checkbox', { name: 'Articles' }).uncheck()
    await page.getByRole('checkbox', { name: 'Tags' }).check()

    const tagOnly = page.getByRole('region', { name: '1 node in this view' })
    await expect(tagOnly.getByRole('link', { name: tagName })).toBeVisible()
    await expect(tagOnly.getByText('Tag', { exact: true })).toBeVisible()

    // Back to the whole graph, so the next step clicks the tag in the list this
    // spec has been reading.
    await page.getByRole('checkbox', { name: 'Tags' }).uncheck()
    await expect(page.getByRole('region', { name: '3 nodes in this view' })).toBeVisible()
  })

  await test.step('sends a reader from a tag to the topic it names', async () => {
    const list = page.getByRole('region', { name: '3 nodes in this view' })
    await list.getByRole('link', { name: tagName }).click()

    await expect(page).toHaveURL(/\/tags\/.+/)
    await expect(page.getByRole('heading', { level: 1, name: tagName })).toBeVisible()
    // Both documents, which is the whole promise of the edge: nothing but the
    // tag connects them.
    await expect(page.getByRole('link', { name: alpha.title })).toBeVisible()
    await expect(page.getByRole('link', { name: beta.title })).toBeVisible()
  })

  await test.step('deletes what it published', async () => {
    await page.goto('/admin/posts')

    for (const document of [alpha, beta]) {
      await page
        .getByRole('row', { name: new RegExp(document.title) })
        .getByRole('button', { name: 'Delete' })
        .click()
      await page.getByRole('button', { name: 'Delete permanently' }).click()
      await expect(page.getByText('Document deleted')).toBeVisible()
    }
  })
})
