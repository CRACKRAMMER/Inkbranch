import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { auditLogs, navigation } from '@/lib/db/schema'
import {
  MAX_NAVIGATION_ITEMS,
  getNavLinks,
  getNavigation,
  isNavigationLocation,
  saveNavigation,
  type NavigationInput,
} from '@/lib/navigation'
import { hrefKindProblem } from '@/lib/security/urls'
import { hasTestDatabase } from '../setup'

/**
 * Navigation.
 *
 * A menu is an ordered list of links, and the two things worth pinning are the
 * hrefs — they are rendered straight into an anchor, so this is where a
 * `javascript:` URL has to stop — and the order the reading experience gets.
 *
 * Validation runs before `saveNavigation` opens a transaction, so a rejected
 * item is rejected without a database and is tested without the guard. Order,
 * replacement and visibility are only visible in the rows themselves, so those
 * need a database and skip without one.
 *
 * There is no test for tree building or for a parent cycle: the `navigation`
 * table has no parent reference, so there is no tree and no cycle to detect.
 * See the module docblock in `src/lib/navigation.ts`.
 */

describe('isNavigationLocation', () => {
  it('accepts the three locations the schema documents', () => {
    expect(isNavigationLocation('header')).toBe(true)
    expect(isNavigationLocation('footer')).toBe(true)
    expect(isNavigationLocation('social')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isNavigationLocation('Header')).toBe(false)
    expect(isNavigationLocation('sidebar')).toBe(false)
    expect(isNavigationLocation('header ')).toBe(false)
    expect(isNavigationLocation('')).toBe(false)
  })
})

describe('href validation for menu items', () => {
  it('accepts a site-relative path on an internal item', () => {
    expect(hrefKindProblem('/posts', false)).toBeNull()
    expect(hrefKindProblem('/posts?tag=react', false)).toBeNull()
  })

  it('accepts http(s) on an external item', () => {
    expect(hrefKindProblem('https://example.com/x', true)).toBeNull()
    expect(hrefKindProblem('http://example.com', true)).toBeNull()
  })

  it('accepts a mailto on an external item only', () => {
    // A contact link leaves the browser but is not another origin, so the flag
    // says external and the rendering keeps rel="noopener".
    expect(hrefKindProblem('mailto:x@example.com', true)).toBeNull()
    expect(hrefKindProblem('mailto:x@example.com', false)).not.toBeNull()
  })

  it('refuses a script URL whichever way the item is marked', () => {
    expect(hrefKindProblem('javascript:alert(1)', true)).not.toBeNull()
    expect(hrefKindProblem('javascript:alert(1)', false)).not.toBeNull()
  })

  it('refuses an href that contradicts the external flag', () => {
    // The flag is what the renderer trusts to decide target="_blank" and
    // rel="noopener noreferrer", so it cannot disagree with the href.
    expect(hrefKindProblem('https://example.com', false)).not.toBeNull()
    expect(hrefKindProblem('/about', true)).not.toBeNull()
  })

  it('refuses the other schemes', () => {
    expect(hrefKindProblem('data:text/html,<script>', true)).not.toBeNull()
    expect(hrefKindProblem('tel:+1234', true)).not.toBeNull()
    expect(hrefKindProblem('ftp://example.com/x', true)).not.toBeNull()
  })

  it('refuses a protocol-relative path, with either slash', () => {
    expect(hrefKindProblem('//evil.example', false)).not.toBeNull()
    expect(hrefKindProblem('/\\evil.example', false)).not.toBeNull()
  })
})

describe('saveNavigation input validation', () => {
  const item = (overrides: Partial<NavigationInput> = {}): NavigationInput => ({
    label: 'Home',
    href: '/',
    ...overrides,
  })

  it('refuses an unknown location before anything else', async () => {
    await expect(
      saveNavigation('sidebar' as 'header', [item()]),
    ).rejects.toMatchObject({ code: 'NAVIGATION', reason: 'unknown_location' })
  })

  it('refuses a menu over the item limit', async () => {
    const items = Array.from({ length: MAX_NAVIGATION_ITEMS + 1 }, (_, index) =>
      item({ label: `Link ${index}`, href: `/page-${index}` }),
    )

    await expect(saveNavigation('header', items)).rejects.toMatchObject({
      code: 'NAVIGATION',
      reason: 'too_many_items',
    })
  })

  it('names the item it rejected', async () => {
    await expect(
      saveNavigation('header', [item(), item({ label: '  ' })]),
    ).rejects.toMatchObject({ code: 'NAVIGATION', reason: 'invalid_item', index: 1 })
  })

  it('refuses a label longer than its column', async () => {
    await expect(
      saveNavigation('header', [item({ label: 'x'.repeat(81) })]),
    ).rejects.toMatchObject({ reason: 'invalid_item', index: 0 })
  })

  it('refuses an icon name that is not kebab-case', async () => {
    // The name becomes a component lookup in the renderer, so it is a closed
    // vocabulary rather than free text.
    await expect(
      saveNavigation('header', [item({ icon: 'GitHub' })]),
    ).rejects.toMatchObject({ reason: 'invalid_item' })
    await expect(
      saveNavigation('header', [item({ icon: 'github mark' })]),
    ).rejects.toMatchObject({ reason: 'invalid_item' })
  })

  it('reports a bad href as a bad href, with its position', async () => {
    await expect(
      saveNavigation('header', [item(), item({ label: 'Bad', href: 'javascript:alert(1)' })]),
    ).rejects.toMatchObject({ code: 'NAVIGATION', reason: 'invalid_href', index: 1 })
  })

  it('reports an external item pointing at a path, and the reverse', async () => {
    await expect(
      saveNavigation('header', [item({ href: 'https://example.com', external: false })]),
    ).rejects.toMatchObject({ reason: 'invalid_href' })
    await expect(
      saveNavigation('header', [item({ href: '/about', external: true })]),
    ).rejects.toMatchObject({ reason: 'invalid_href' })
  })
})

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('navigation storage', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  const clear = () => db.delete(navigation)

  const links = (...items: NavigationInput[]) => items

  it('returns an empty menu for a location with no rows', async () => {
    await clear()
    expect(await getNavigation('header')).toEqual([])
    expect(await getNavLinks('header')).toEqual([])
  })

  it('stores the menu in the order it was given', async () => {
    await clear()
    const saved = await saveNavigation(
      'header',
      links(
        { label: 'Home', href: '/' },
        { label: 'Posts', href: '/posts' },
        { label: 'About', href: '/about' },
      ),
    )

    expect(saved.map((row) => row.label)).toEqual(['Home', 'Posts', 'About'])
    expect(saved.map((row) => row.position)).toEqual([0, 1, 2])
    expect((await getNavigation('header')).map((row) => row.label)).toEqual([
      'Home',
      'Posts',
      'About',
    ])
  })

  it('replaces the menu rather than appending to it', async () => {
    await clear()
    await saveNavigation('header', links({ label: 'A', href: '/a' }, { label: 'B', href: '/b' }))
    await saveNavigation('header', links({ label: 'B', href: '/b' }))

    const rows = await getNavigation('header')
    expect(rows.map((row) => row.label)).toEqual(['B'])
    expect(rows.map((row) => row.position)).toEqual([0])
  })

  it('rewrites the order when the menu is reordered', async () => {
    await clear()
    await saveNavigation('header', links({ label: 'A', href: '/a' }, { label: 'B', href: '/b' }))
    await saveNavigation('header', links({ label: 'B', href: '/b' }, { label: 'A', href: '/a' }))

    expect((await getNavigation('header')).map((row) => row.label)).toEqual(['B', 'A'])
  })

  it('empties a menu', async () => {
    await clear()
    await saveNavigation('header', links({ label: 'A', href: '/a' }))
    expect(await saveNavigation('header', [])).toEqual([])
    expect(await getNavigation('header')).toEqual([])
  })

  it('leaves the other locations alone', async () => {
    await clear()
    await saveNavigation('header', links({ label: 'A', href: '/a' }))
    await saveNavigation('footer', links({ label: 'Legal', href: '/legal' }))
    await saveNavigation('header', links({ label: 'B', href: '/b' }))

    expect((await getNavigation('header')).map((row) => row.label)).toEqual(['B'])
    expect((await getNavigation('footer')).map((row) => row.label)).toEqual(['Legal'])
  })

  it('hides an invisible item from the reader and keeps it for the editor', async () => {
    await clear()
    await saveNavigation(
      'header',
      links(
        { label: 'Shown', href: '/shown' },
        { label: 'Hidden', href: '/hidden', visible: false },
        { label: 'Also shown', href: '/also' },
      ),
    )

    // The visible menu skips a position but keeps the relative order, which is
    // what the header renders: hiding an item must not reorder the rest.
    expect((await getNavigation('header')).map((row) => row.label)).toEqual([
      'Shown',
      'Also shown',
    ])
    expect((await getNavigation('header', { includeHidden: true })).map((row) => row.label)).toEqual(
      ['Shown', 'Hidden', 'Also shown'],
    )
  })

  it('hands the reader only what a link needs', async () => {
    await clear()
    await saveNavigation(
      'social',
      links(
        { label: 'GitHub', href: 'https://github.com/x', external: true, icon: 'github' },
        { label: 'Hidden', href: '/nope', visible: false },
      ),
    )

    expect(await getNavLinks('social')).toEqual([
      { label: 'GitHub', href: 'https://github.com/x', external: true, icon: 'github' },
    ])
  })

  it('defaults the flags and normalises the text', async () => {
    await clear()
    const [row] = await saveNavigation(
      'footer',
      links({ label: '  Legal  ', href: '  /legal  ' }),
    )

    expect(row).toMatchObject({ label: 'Legal', href: '/legal', visible: true, external: false })
    expect(row?.icon).toBeNull()
  })

  it('accepts exactly the item limit', async () => {
    await clear()
    const items = Array.from({ length: MAX_NAVIGATION_ITEMS }, (_, index) => ({
      label: `Link ${index}`,
      href: `/page-${index}`,
    }))

    const saved = await saveNavigation('header', items)
    expect(saved).toHaveLength(MAX_NAVIGATION_ITEMS)
    expect((await getNavigation('header')).at(-1)?.label).toBe(
      `Link ${MAX_NAVIGATION_ITEMS - 1}`,
    )
  })

  it('records the change in the audit log', async () => {
    await clear()

    // Identified by the ids that existed before the write: another suite is
    // writing audit rows into the same database while this one runs.
    const before = new Set(
      (await db.select({ id: auditLogs.id }).from(auditLogs)).map((row) => row.id),
    )

    await saveNavigation('footer', links({ label: 'A', href: '/a' }, { label: 'B', href: '/b' }))

    const written = (
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'navigation.update'))
    ).filter((row) => !before.has(row.id))

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ targetType: 'navigation', targetId: 'footer', userId: null })
    expect(written[0]?.meta).toMatchObject({ location: 'footer', count: 2 })
  })
})
