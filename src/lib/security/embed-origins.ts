/**
 * The origins this deployment trusts to be framed, and to serve its media.
 *
 * ## Why the list lives here and not next to either of its readers
 *
 * An embed is permitted by two mechanisms that never meet. `rehypeEnhance`
 * decides which `<iframe>` elements survive the Markdown pipeline, and the
 * CSP's `frame-src` decides which of the survivors a browser will actually
 * load. Both need the same answer to "which origins does this site trust?",
 * and they are far apart: one runs per document, the other is a response
 * header built in `next.config.ts` at start-up.
 *
 * They were written twice and they disagreed — the CSP named three origins and
 * the renderer ten, so seven trusted origins kept their `<iframe>` through the
 * pipeline and had it refused by the browser. The reader got an empty
 * rectangle, the document was unchanged, and nothing logged a word. Keeping
 * the list in a module both import is what makes that impossible rather than
 * merely unlikely; `tests/unit/embed-origins.test.ts` reads the CSP back out
 * of the config and compares the two.
 *
 * This module imports nothing, deliberately: `next.config.ts` loads it before
 * anything else exists, so it cannot depend on the database, the environment,
 * or a Markdown package.
 *
 * ## Adding an origin
 *
 * It is one edit here, and the sanitiser, the browser, and the test all move
 * together. An entry is a decision about what this site's pages may talk to —
 * an embed is a hole through the page's CSP and the reader's privacy — so the
 * list stays explicit rather than accepting any https host.
 */

/** Origins permitted in an `<iframe>`. */
export const ALLOWED_EMBED_ORIGINS = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'player.vimeo.com',
  'www.bilibili.com',
  'player.bilibili.com',
  'codesandbox.io',
  'stackblitz.com',
  'observablehq.com',
  'www.desmos.com',
] as const

/** Origins permitted in `<video>`/`<audio>` sources. */
export const ALLOWED_MEDIA_ORIGINS = ['cdn.jsdelivr.net'] as const

/**
 * Whether a URL may be loaded into a frame on this site.
 *
 * One expression with two callers — the pipeline that keeps an element and the
 * config that builds the header — so the answer a browser enforces and the
 * answer the renderer applies are the same answer.
 *
 * A subdomain of an allowed origin is allowed, because `www.youtube.com` and
 * `player.youtube.com` are the same publisher. A host that merely *ends with*
 * an allowed name is not: `evil-youtube.com` and `youtube.com.evil.test` both
 * contain a trusted string and neither is trusted. `isAllowedEmbed` is
 * compared on the parsed hostname for that reason, never with `includes`.
 *
 * A relative source is same-origin by definition and is allowed — but only a
 * single leading slash is relative. `//evil.test/x` is a protocol-relative
 * URL: it parses against the page's scheme and points at another host, so
 * treating it as a local path is how a same-origin allowance becomes an open
 * one. `/\evil.test/x` is the same attack written with a backslash.
 */
export function isAllowedEmbed(src: string, allowedOrigins: readonly string[]): boolean {
  // The browser does not judge the string this function was handed: it reads
  // `\` as `/`, ignores a tab or newline anywhere, and trims the ends before
  // parsing, so `https:\\evil.test` and `java\tscript:alert(1)` are not the
  // strings a URL parser sees. Normalising first means the answer below is
  // about the URL the browser will fetch, not the one that was typed.
  const candidate = src.replace(/[\t\n\r]/g, '').replace(/\\/g, '/').trim()

  if (candidate.startsWith('/') && !candidate.startsWith('//')) return true

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') return false
  return allowedOrigins.some(
    (origin) => parsed.hostname === origin || parsed.hostname.endsWith(`.${origin}`),
  )
}
