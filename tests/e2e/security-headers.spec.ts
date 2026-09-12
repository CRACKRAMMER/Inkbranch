import { expect, test } from '@playwright/test'

import { ALLOWED_EMBED_ORIGINS, ALLOWED_MEDIA_ORIGINS } from '@/lib/security/embed-origins'

/**
 * The policy the deployment actually sends.
 *
 * `embed-origins.test.ts` compares the allow-list with the CSP *as configured*,
 * which catches the two drifting apart in the source. It cannot catch the other
 * half: a config that is read but not applied — a rule whose `source` no longer
 * matches anything, a header overwritten further down the chain — leaves the
 * unit test green and the browser ungoverned. This asks the running server.
 *
 * The failure this exists for is the quiet one. An embed whose origin the
 * renderer keeps and the browser refuses is an empty rectangle: the document
 * was not changed, no log line was written, and the page is not broken enough
 * to investigate.
 *
 * No fixtures and no sign-in: the headers are on every page.
 */

/** The directives of a policy string, as `name → sources`. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

async function policyOf(page: import('@playwright/test').Page, path: string): Promise<string> {
  const response = await page.goto(path)
  expect(response, `no response for ${path}`).not.toBeNull()
  const policy = response?.headers()['content-security-policy']
  expect(policy, `${path} was served without a Content-Security-Policy`).toBeTruthy()
  return policy ?? ''
}

test('the reader is sent the policy the renderer was told to trust', async ({ page }) => {
  const policy = await policyOf(page, '/')
  const frameSrc = directives(policy).get('frame-src') ?? []

  for (const origin of ALLOWED_EMBED_ORIGINS) {
    expect(frameSrc, `frame-src is missing ${origin}`).toContain(`https://${origin}`)
  }
  expect(frameSrc).toContain("'self'")

  // The other direction, so the browser is not permitted more than the
  // pipeline will render: a source allowed here but dropped by `rehypeEnhance`
  // is a hole that buys nothing.
  const allowed = ALLOWED_EMBED_ORIGINS.map((origin) => `https://${origin}`)
  for (const source of frameSrc) {
    if (source === "'self'") continue
    expect(allowed, `frame-src permits ${source}, which is not on the allow-list`).toContain(source)
  }

  const mediaSrc = directives(policy).get('media-src') ?? []
  expect(mediaSrc).toContain("'self'")
  for (const origin of ALLOWED_MEDIA_ORIGINS) {
    expect(mediaSrc, `media-src is missing ${origin}`).toContain(`https://${origin}`)
  }
})

test('the document routes carry it too, not only the home page', async ({ page }) => {
  // A rule that matched only some paths would leave every other page on
  // `default-src 'self'` — which is stricter, so nothing would look wrong
  // until an embed on one of those pages stopped loading.
  for (const path of ['/posts', '/notes', '/about', '/graph']) {
    const frameSrc = directives(await policyOf(page, path)).get('frame-src') ?? []
    expect(frameSrc, `frame-src is missing on ${path}`).toContain('https://www.youtube.com')
  }
})
