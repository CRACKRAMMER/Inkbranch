import { expect, test, type Page } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * Reading a long document: the contents list.
 *
 * The one thing this spec is here for is the jump. Everything else about the TOC
 * — that it lists the headings, that it indents by level — is visible in the
 * markup and would be caught by a rendering test; the jump is a behaviour that
 * only exists once the click, the browser's own anchor navigation and the
 * scroll animation have all three happened, and it is the part of the brief a
 * reader notices immediately when it is wrong.
 *
 * ### Why the animated-scroll assertions are written the way they are
 *
 * Animated scrolling cannot be seen from the outside: Playwright has no
 * "watch the viewport move" assertion, and a test that read the scroll position
 * mid-flight would be racing the browser's own easing curve. What *is*
 * deterministic is the mechanism — the page asks for a smooth scroll for the
 * length of one jump and then stops asking — so the assertion is on that, read
 * in the same JavaScript turn as the click, before a frame can run.
 *
 * That turn is also why one of the clicks below is dispatched with
 * `element.click()` rather than `locator.click()`. It is the same event handler
 * either way; doing it inside the evaluation is what makes the reading a
 * measurement rather than a race.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a reader moves through a long document from its contents list', async ({ page }) => {
  const slug = uniqueSlug()
  const title = `E2E Reading ${slug}`

  // Headings chosen so the list has to show two levels, and so the last one is
  // far enough down the page that reaching it is a scroll and not a nudge.
  const sections = ['Introduction', 'Setup', 'Details of the setup', 'Conclusion'] as const

  const paragraph =
    'A paragraph long enough to take up several lines of the reading measure, so that ' +
    'the distance between two headings is a real scroll rather than a hop.'
  const filler = Array.from({ length: 8 }, () => paragraph).join('\n\n')

  const body = [
    `## ${sections[0]}`,
    filler,
    `## ${sections[1]}`,
    filler,
    `### ${sections[2]}`,
    filler,
    `## ${sections[3]}`,
    filler,
  ].join('\n\n')

  await test.step('publishes a document long enough to need a contents list', async () => {
    await signIn(page)
    await page.goto('/admin/posts/new')
    await page.fill('#title', title)
    await page.fill('#slug', slug)
    await page.selectOption('#status', 'draft')
    await page.getByRole('button', { name: 'Create and edit' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))

    await typeBody(page, body)
    await showMetadata(page)
    await page.selectOption('#fm-status', 'published')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/Saved to file/)).toBeVisible()
  })

  await test.step('lists every heading, indented by level', async () => {
    await page.goto(`/posts/${slug}`)
    await openContents(page)

    const contents = page.getByRole('navigation', { name: 'On this page' })
    for (const heading of sections) {
      await expect(contents.getByRole('link', { name: heading, exact: true })).toBeVisible()
    }

    // The indent is a `data-depth` attribute rather than nested markup, so this
    // asserts the attribute *and* that the stylesheet turns it into a real
    // indent — the first alone would pass with the CSS rule deleted.
    const detail = contents.getByRole('link', { name: sections[2], exact: true })
    await expect(detail).toHaveAttribute('data-depth', '3')
    await expect(detail).toHaveCSS('padding-left', '28px')
    await expect(contents.getByRole('link', { name: sections[1], exact: true })).toHaveCSS(
      'padding-left',
      '14px',
    )
  })

  await test.step('opens the contents as a drawer where the rail is not rendered', async () => {
    const trigger = page.getByRole('button', { name: 'Contents' })

    // The wide viewport has the rail, which is the other half of this: there is
    // one contents list per width, never two and never none.
    if (!(await trigger.isVisible())) return

    // A fresh load, so the drawer starts closed rather than wherever the step
    // above left it.
    await page.goto(`/posts/${slug}`)

    // Closed means absent, not merely hidden: a reader at this width should
    // find the list in the drawer and nowhere else in the article.
    await expect(page.locator('a.toc-link:visible')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Contents' })).toHaveCount(0)

    await trigger.click()

    const drawer = page.getByRole('dialog', { name: 'Contents' })
    await expect(drawer).toBeVisible()

    const target = await fragmentFor(page, sections[3])
    await drawer.getByRole('link', { name: sections[3], exact: true }).click()

    // Picking a section puts the list away — otherwise it covers the section
    // the reader just asked for — and the jump still happens behind it, which
    // is the whole reason the drawer is not a modal dialog: a modal one locks
    // the page scroll, and the scroll the link asks for would be discarded.
    await expect(drawer).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[3])).toBeInViewport()
  })

  await test.step('keeps the reading measure inside the brief at every width', async () => {
    const original = page.viewportSize()

    // The widths below are the ones the layout has a decision to make at: the
    // widest screen the container can reach, the breakpoint the rails come back
    // at, either side of it, and the narrowest width that is not a phone.
    for (const width of [1440, 1280, 1180, 1024, 900, 768]) {
      await page.setViewportSize({ width, height: 900 })

      const measured = await page
        .locator('#article-body')
        .evaluate((node) => node.getBoundingClientRect().width)

      // 680–760px is what the brief asks for, and the number is what a reader
      // gets: a measure is not a `max-width` in a stylesheet, it is the width
      // of the column the text is actually in.
      expect(measured, `article width at ${width}px`).toBeGreaterThanOrEqual(680)
      expect(measured, `article width at ${width}px`).toBeLessThanOrEqual(760)
    }

    if (original) await page.setViewportSize(original)
  })

  await test.step('jumps to the section a reader picks', async () => {
    await openContents(page)
    const target = await fragmentFor(page, sections[1])
    await page.getByRole('navigation', { name: 'On this page' })
      .getByRole('link', { name: sections[1], exact: true })
      .click()

    // The fragment reaches the URL, which is the assertion that this feature did
    // not cost the reader the browser's own behaviour: the address is still
    // shareable and Back still works.
    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[1])).toBeInViewport()

    // And the page stops asking for animated scrolling once the jump is over.
    // It has to stop: the property applies to every scroll of the viewport,
    // including the ones Next makes when a navigation lands on a new page.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.scrollBehavior))
      .toBe('')
  })

  await test.step('asks for an animated scroll, and only for the jump', async () => {
    await openContents(page)
    const target = await fragmentFor(page, sections[3])
    const during = await clickInPage(page, target)

    expect(during).toBe('smooth')

    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[3])).toBeInViewport()

    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.scrollBehavior))
      .toBe('')
  })

  await test.step('does not animate for a reader who asked for less motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openContents(page)
    const target = await fragmentFor(page, sections[0])

    const during = await clickInPage(page, target)

    // Nothing was asked for, so the jump is the browser's plain one — which is
    // the whole reason this is a check on the mechanism and not on a CSS rule:
    // a global `scroll-behavior: smooth` would have animated it, and no
    // `prefers-reduced-motion` override in the stylesheet could tell the
    // difference between this jump and a page load.
    expect(during).toBe('')
    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[0])).toBeInViewport()
  })

  await test.step('deletes what it published', async () => {
    await page.goto('/admin/posts')
    await page
      .getByRole('row', { name: new RegExp(title) })
      .getByRole('button', { name: 'Delete' })
      .click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()

    // The toast, not the row: everything outside the open modal is `aria-hidden`
    // and `getByRole` cannot see an `aria-hidden` subtree, so a check on the row
    // would pass before the request went out.
    await expect(page.getByText('Document deleted')).toBeVisible()
  })
})

/**
 * The heading the jump is supposed to land on.
 *
 * Not matched with `exact`. Every rendered heading carries a permalink anchor
 * whose accessible name is `Link to <heading>`, and an accessible name is
 * computed from the subtree — so the heading's own name is `Setup Link to
 * Setup`, and an exact match finds nothing. The level is what keeps the match
 * unambiguous instead: `Setup` as a substring would otherwise be satisfied by
 * the `Details of the setup` heading below it.
 */
function landing(page: Page, heading: string) {
  return page.getByRole('heading', { level: 2, name: heading })
}

/**
 * Reveal the contents list, where it is behind a drawer.
 *
 * There are two presentations and only ever one of them is on screen: the rail
 * on a wide viewport, and — below `lg`, where the rail is not rendered at all —
 * a bottom drawer behind a trigger beside the title. Checking whether a link is
 * already reachable rather than checking the viewport width is the difference
 * between testing the layout and testing a media query — the same reason
 * `showMetadata` in `support.ts` asks about the switcher rather than the width.
 *
 * The drawer is a dialog, and a closed one has no contents in the DOM at all,
 * so this has to run *before* anything looks for a link. It is written to be
 * safe to call more than once, because the drawer closes itself when a section
 * is picked: if a link is already visible, there is nothing to open, and
 * clicking the trigger again would close the drawer instead.
 */
async function openContents(page: Page): Promise<void> {
  // `:visible`, not `first()`: on a phone the rail is still in the markup with
  // `display: none`, and it comes first in the document.
  if (await page.locator('a.toc-link:visible').first().isVisible()) return

  const trigger = page.getByRole('button', { name: 'Contents' })
  if (await trigger.isVisible()) await trigger.click()
}

/**
 * Click a TOC link from inside the page and report what the root was asking for
 * at that instant.
 *
 * One evaluation, so no frame runs between the click and the reading: the
 * handler sets the property synchronously, and the browser's own scroll — the
 * one being asked for smoothly — starts after the event has finished
 * dispatching. Read from outside, this would be a race against the animation.
 */
async function clickInPage(page: Page, fragment: string): Promise<string> {
  return page.evaluate((target) => {
    const link = document.querySelector<HTMLAnchorElement>(`a.toc-link[href="#${target}"]`)
    if (!link) throw new Error(`no contents link for #${target}`)
    link.click()
    return document.documentElement.style.scrollBehavior
  }, fragment)
}

/**
 * The fragment a section's contents link points at, taken from the page.
 *
 * Read rather than derived. The heading ids are generated by the renderer's own
 * slugger, and a second implementation of that rule living in the test would be
 * a copy of it that can disagree with the original — the copy would be asserting
 * that the test agrees with itself.
 */
async function fragmentFor(page: Page, heading: string): Promise<string> {
  const href = await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: heading, exact: true })
    .getAttribute('href')

  if (!href?.startsWith('#')) throw new Error(`contents link for "${heading}" has no fragment`)
  return href.slice(1)
}

/** A fragment used inside a `RegExp`, where the renderer's ids are not literal. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
