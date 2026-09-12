import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionList } from '@/components/admin/session-list'
import type { SessionSummary } from '@/lib/auth/session-store'

/**
 * The account's last sign-in, as the device list renders it.
 *
 * ## Why this is a unit test at all
 *
 * The rest of `SessionList` is a table of rows the store hands it, and the
 * integration suite owns what those rows may carry. What is added here is one
 * value that does not come from the store at all — it is `users.last_login_at`,
 * read by nothing until now — and the branch where it is absent. The browser
 * suite proves the value reaches the screen after a real sign-in; it cannot
 * reach the absent branch, because a session only exists because a sign-in
 * happened, so the row would have to be edited by hand to get there.
 *
 * Rendered through `createElement` rather than JSX because the unit suite's
 * `include` is `tests/unit/**\/*.test.ts`, the same reason `cover-image.test.ts`
 * gives. `renderToString` is the server renderer, which is how the page is
 * built, so nothing here is a client-render approximation.
 */

const CTX = {
  locale: 'en',
  timeZone: 'UTC',
  now: new Date('2026-09-13T12:00:00Z'),
}

const AT = new Date('2026-09-13T09:00:00Z')

function row(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
    ipHash: 'abcdef0123456789',
    createdAt: AT,
    lastSeenAt: AT,
    expiresAt: new Date('2026-10-13T09:00:00Z'),
    ...overrides,
  } as SessionSummary
}

function render(lastSignInAt: Date | null): string {
  return renderToString(
    createElement(SessionList, {
      sessions: [row()],
      currentSessionId: 'session-1',
      lastSignInAt,
      context: CTX,
    }),
  )
}

describe('the device list', () => {
  it('states the account’s last sign-in, as a time element rather than prose', () => {
    const html = render(AT)

    expect(html).toContain('<time dateTime="2026-09-13T09:00:00.000Z"')
    // The sentence that says why the line is not the newest row repeated — the
    // claim that makes it worth its space.
    expect(html).toContain('it survives them')
  })

  it('renders the absent case as a dash, not as a time it does not have', () => {
    // Sliced from the end of the table because the rows above carry `<time>`
    // elements of their own, and an assertion against the whole document would
    // be satisfied by theirs — passing for a reason that has nothing to do with
    // this line.
    const line = render(null).slice(render(null).indexOf('</table>'))

    expect(line).not.toContain('<time')
    expect(line).toContain('<span class="font-mono">—</span>')
  })

  /**
   * The line sits outside the table. A column would put it in the same grid as
   * the rows it outlives, and it belongs to the account rather than to any of
   * them — so it is a paragraph after `</table>`.
   */
  it('places the line after the table rather than inside it', () => {
    const html = render(AT)

    const table = html.indexOf('</table>')
    const line = html.indexOf('last signed in to')

    expect(table).toBeGreaterThan(-1)
    expect(line).toBeGreaterThan(table)
  })
})
