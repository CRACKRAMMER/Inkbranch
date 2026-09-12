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
 * deterministic is the request the page makes — a smooth scroll of the target,
 * asked for once, by name — so the assertion is on that, read in the same
 * JavaScript turn as the click, before a frame can run. Whether the request was
 * honoured is asserted separately and afterwards, by the viewport.
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

    // The fragment reaches the URL: the address is still shareable and Back
    // still works. The page writes it now rather than the browser, so this is a
    // check on the half of the navigation it took over, not on the browser's.
    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[1])).toBeInViewport()

    // And the section is where the next Tab starts from. That is the other half
    // of what a prevented navigation would have cost: a reader who arrived by
    // keyboard carries on from the section they picked rather than from the
    // contents list they picked it out of.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id || null))
      .toBe(target)
  })

  await test.step('asks for an animated scroll, and only for the jump', async () => {
    await openContents(page)
    const target = await fragmentFor(page, sections[3])
    const during = await clickInPage(page, target)

    expect(during.behavior).toBe('smooth')
    // The other half of the claim in the step's name: the animation is asked for
    // on this one scroll and never on the root, so no navigation, no page load
    // and no restore can pick it up by accident.
    expect(during.root).toBe('')

    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[3])).toBeInViewport()
  })

  await test.step('does not animate for a reader who asked for less motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openContents(page)
    const target = await fragmentFor(page, sections[0])
    const during = await clickInPage(page, target)

    // An immediate scroll is asked for by name rather than left to the browser's
    // default, which is the whole reason this is a check on the mechanism and
    // not on a CSS rule: the choice is made where the jump is made, and a
    // `prefers-reduced-motion` block in the stylesheet is not what tells this
    // jump apart from a page load.
    expect(during.behavior).toBe('auto')
    expect(during.root).toBe('')
    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(target)}$`))
    await expect(landing(page, sections[0])).toBeInViewport()
  })

  await test.step('lands the second of two jumps asked for in quick succession', async () => {
    // A reader who changes their mind mid-glide: the first jump is still moving
    // when the second one is asked for. That is the state the browser cannot be
    // left to handle — Chromium drops a fragment navigation's scroll while one
    // of its own smooth scrolls is running, so the address moved to the second
    // section and the page stayed at the first — and no other step in this spec
    // can catch it, because every other jump is made from a page that is
    // standing still.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await openContents(page)

    const first = await fragmentFor(page, sections[0])
    const last = await fragmentFor(page, sections[3])

    const asked = await page.evaluate(
      async ({ first: toFirst, last: toLast }) => {
        // Resolved at the moment of each click, and from the document rather
        // than through the accessible tree. Below `xl` the list a reader taps is
        // the one in the drawer, and following a link unmounts the drawer and
        // the links inside it — so a reference taken once would be detached by
        // the time the second jump is asked for, and a click on a detached
        // anchor reaches the browser without reaching the page. What is wanted
        // is the one on screen, and failing that whichever is in the document;
        // the handler under test is on both lists at either width.
        const link = (fragment: string) => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(`a.toc-link[href="#${fragment}"]`),
          )
          const found = candidates.find((node) => node.offsetParent !== null) ?? candidates[0]
          if (!found) throw new Error(`no contents link for #${fragment}`)
          return found
        }

        window.scrollTo({ top: 0, behavior: 'auto' })
        await new Promise((resolve) => setTimeout(resolve, 50))

        link(toLast).click()
        // Long enough that the glide is well under way and nowhere near arrived.
        await new Promise((resolve) => setTimeout(resolve, 150))
        const midY = Math.round(window.scrollY)

        link(toFirst).click()
        await new Promise((resolve) => setTimeout(resolve, 1200))

        return { midY }
      },
      { first, last },
    )

    // The first jump was genuinely in flight when the second was asked for. If
    // it had already arrived, this step would be asserting nothing.
    expect(asked.midY).toBeGreaterThan(0)

    await expect(page).toHaveURL(new RegExp(`#${escapeForRegExp(first)}$`))
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
 * Click a TOC link from inside the page and report what the page asked the
 * browser for, at that instant.
 *
 * One evaluation, so no frame runs between the click and the reading: the
 * handler decides synchronously, and the scroll it asks for starts after the
 * event has finished dispatching. Read from outside, this would be a race
 * against the animation.
 *
 * `scrollIntoView` is spied on rather than the page's position being compared
 * before and after, because the request is the thing that differs — an
 * immediate jump and an animated one end in the same place, and only the
 * request says which was asked for. The root's inline style is read in the same
 * turn for the other half of the claim: that the animation is asked for on this
 * one scroll and never on the root.
 */
async function clickInPage(
  page: Page,
  fragment: string,
): Promise<{ behavior: string | null; root: string }> {
  return page.evaluate((target) => {
    const link = document.querySelector<HTMLAnchorElement>(`a.toc-link[href="#${target}"]`)
    if (!link) throw new Error(`no contents link for #${target}`)

    const native = Element.prototype.scrollIntoView
    let behavior: string | null = null
    Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      if (typeof options === 'object' && options !== null) behavior = options.behavior ?? null
      native.call(this, options)
    }

    try {
      link.click()
    } finally {
      Element.prototype.scrollIntoView = native
    }

    return { behavior, root: document.documentElement.style.scrollBehavior }
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
