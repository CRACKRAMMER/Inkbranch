import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config'
import {
  ALLOWED_EMBED_ORIGINS,
  ALLOWED_MEDIA_ORIGINS,
  isAllowedEmbed,
} from '@/lib/security/embed-origins'

/**
 * The two halves of one decision have to be the same decision.
 *
 * An embed is permitted by two independent mechanisms, and both have to say
 * yes: `rehypeEnhance` keeps an `<iframe>` whose origin is on the allow-list
 * and *deletes* one that is not, and the CSP's `frame-src` decides whether the
 * browser will load the frame that survived. Let the lists drift and the
 * failure is silent in the worst way — the pass keeps the element, so the
 * document is not changed, and the browser refuses the frame, so the reader
 * gets an empty rectangle. Nothing in the pipeline reports it, and no page
 * looks broken enough to investigate.
 *
 * They did drift: the CSP named three origins and the allow-list ten, so seven
 * trusted origins rendered a dead frame. These assertions are the reason that
 * cannot happen again — they read the CSP out of `next.config.ts` rather than
 * restating it, so the config is tested as the deployment receives it.
 */

/**
 * The CSP this deployment sends.
 *
 * Found by looking for the rule that carries one rather than by its `source`,
 * so this keeps working if the paths a rule covers are ever reshaped.
 */
async function policy(): Promise<string> {
  const headers = nextConfig.headers
  if (!headers) throw new Error('next.config.ts declares no headers()')

  const rules = await headers()
  const csp = rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'Content-Security-Policy')
  if (!csp) throw new Error('no Content-Security-Policy in the header rules')
  return csp.value
}

/** The sources listed for one directive, `'self'` included. */
function sources(csp: string, name: string): string[] {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
  return directive ? directive.split(/\s+/).slice(1) : []
}

describe('the CSP and the embed allow-list', () => {
  it('lets the browser load every origin the renderer was told to trust', async () => {
    const frameSrc = sources(await policy(), 'frame-src')

    for (const origin of ALLOWED_EMBED_ORIGINS) {
      expect(frameSrc, `frame-src is missing ${origin}`).toContain(`https://${origin}`)
    }
  })

  it('trusts nothing in the browser that the renderer would delete anyway', async () => {
    const frameSrc = sources(await policy(), 'frame-src')
    const allowed = ALLOWED_EMBED_ORIGINS.map((origin) => `https://${origin}`)

    // The other direction, so the two lists are equal rather than merely
    // compatible: an origin the CSP permits but `rehypeEnhance` strips is a
    // hole in the page's policy that buys nothing.
    for (const source of frameSrc) {
      if (source === "'self'") continue
      expect(allowed, `frame-src permits ${source}, which is not on the allow-list`).toContain(
        source,
      )
    }
  })

  it('states the media policy instead of inheriting it from default-src', async () => {
    const mediaSrc = sources(await policy(), 'media-src')

    // `default-src 'self'` would block every one of these, so the allow-list
    // would be a comment rather than a policy.
    expect(mediaSrc).toContain("'self'")
    for (const origin of ALLOWED_MEDIA_ORIGINS) {
      expect(mediaSrc, `media-src is missing ${origin}`).toContain(`https://${origin}`)
    }
  })

  it('is derived from the allow-list rather than written out again', async () => {
    // A hand-written copy is free to disagree with the list; a derived one is
    // not. This is the property, not a restatement of the contents: the two
    // frame sources that are not `'self'` come from the module.
    const csp = await policy()
    const embedOrigins = ALLOWED_EMBED_ORIGINS.map((origin) => `https://${origin}`)

    expect(sources(csp, 'frame-src').filter((s) => s !== "'self'").sort()).toEqual(
      [...embedOrigins].sort(),
    )
  })
})

describe('isAllowedEmbed', () => {
  const origins = ['youtube.com', 'player.bilibili.com']

  it('accepts an allow-listed origin and its subdomains', () => {
    expect(isAllowedEmbed('https://youtube.com/embed/abc', origins)).toBe(true)
    expect(isAllowedEmbed('https://www.youtube.com/embed/abc', origins)).toBe(true)
    expect(isAllowedEmbed('https://player.bilibili.com/player.html?bvid=1', origins)).toBe(true)
    // Hostnames are compared case-insensitively by URL parsing.
    expect(isAllowedEmbed('https://YOUTUBE.COM/embed/abc', origins)).toBe(true)
  })

  it('rejects a hostname that merely contains an allowed one', () => {
    for (const url of [
      'https://evil-youtube.com/embed/abc',
      'https://youtube.com.evil.test/embed/abc',
      'https://evil.test/https://youtube.com/embed/abc',
      'https://notyoutube.com/embed/abc',
    ]) {
      expect(isAllowedEmbed(url, origins)).toBe(false)
    }
  })

  it('rejects anything that is not https', () => {
    expect(isAllowedEmbed('http://youtube.com/embed/abc', origins)).toBe(false)
    expect(isAllowedEmbed('javascript:alert(1)', origins)).toBe(false)
    expect(isAllowedEmbed('data:text/html,<script>alert(1)</script>', origins)).toBe(false)
  })

  it('accepts a same-origin path, which needs no origin in the list', () => {
    expect(isAllowedEmbed('/embed/abc', origins)).toBe(true)
    expect(isAllowedEmbed('/embed/abc', [])).toBe(true)
  })

  it('rejects a protocol-relative source, however it is spelled', () => {
    // `//host/x` is not a path: it resolves against the page's scheme and
    // points somewhere else entirely, so the same-origin allowance above would
    // become an open one if it were read as one. `/**\/` is the same URL — a
    // browser reads `\` as `/` — and a whitespace-split one parses the same
    // way again once the browser strips the characters it ignores.
    for (const url of [
      '//youtube.com/embed/abc',
      '/\\/youtube.com/embed/abc',
      '/\t/youtube.com/embed/abc',
    ]) {
      expect(isAllowedEmbed(url, origins)).toBe(false)
    }
  })

  it('normalises a source the way the browser will read it', () => {
    // Backslashes are slashes to a URL parser, so this is an ordinary
    // youtube embed rather than an opaque string.
    expect(isAllowedEmbed('https:\\youtube.com\\embed\\abc', origins)).toBe(true)
    // Control characters are stripped before parsing, so a scheme cannot be
    // smuggled past the protocol check by breaking it up.
    expect(isAllowedEmbed('java\tscript:alert(1)', origins)).toBe(false)
  })

  it('rejects a source that is not a usable URL', () => {
    expect(isAllowedEmbed('not a url', origins)).toBe(false)
    expect(isAllowedEmbed('', origins)).toBe(false)
  })

  it('rejects every host when the allow-list is empty', () => {
    expect(isAllowedEmbed('https://youtube.com/embed/abc', [])).toBe(false)
  })
})
