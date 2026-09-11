import { sanitizeSvg, sniffMime } from '@/lib/security/mime'

/**
 * SVG preparation.
 *
 * An SVG is the one image format that is also a script host: it can carry
 * `<script>`, `on*` handlers, and references that leak the reader's IP every
 * time the file is displayed. Since assets are served from our own origin, an
 * unsanitised SVG is stored XSS, which is why the bytes written to disk are the
 * *sanitised* ones and never the upload.
 *
 * Two things this module is not:
 *
 *   - It is not the whole defence. `sanitizeSvg` is a blocklist over the
 *     known-dangerous shapes (see its own doc comment), so treat its output as
 *     "no longer an obvious script host". The serving route must send
 *     `Content-Security-Policy: default-src 'none'; sandbox`, and must never
 *     serve an SVG as `text/html` — that header is what makes a trick this
 *     function did not anticipate harmless, and the content type is what stops
 *     the browser from parsing the file as a document in the first place.
 *   - It is not a place to refuse an upload. An SVG that lost its `<style>`
 *     block is still a usable asset, so the removals are reported rather than
 *     thrown, and the admin sees what was stripped.
 *
 * This module deliberately has no `server-only` marker: like
 * `@/lib/security/mime`, it is a pure text transformation with no server
 * surface, and keeping it that way is what lets it be tested directly.
 */

export class SvgSanitisationError extends Error {
  readonly code = 'SVG_SANITIZATION'

  constructor(message: string) {
    super(message)
    this.name = 'SvgSanitisationError'
  }
}

export interface PreparedSvg {
  /** UTF-8 bytes of the sanitised document: what gets stored. */
  svg: Buffer
  /**
   * Constructs the sanitiser removed, by name — `script`, `event handler
   * attributes`, `external reference`, and so on. Empty for a clean file.
   */
  removed: string[]
}

/**
 * Sanitise an uploaded SVG.
 *
 * `sniffMime` has already established that these bytes look like an SVG; this
 * checks the same thing again on the way out, because the invariant that
 * matters is about what is *stored*. A document that sanitises down to
 * something that no longer sniffs as an SVG is not written at all.
 */
export function prepareSvg(source: Buffer): PreparedSvg {
  const { svg, removed } = sanitizeSvg(source.toString('utf8'))

  if (svg.length === 0) {
    throw new SvgSanitisationError('The SVG contains no markup after sanitisation')
  }

  const bytes = Buffer.from(svg, 'utf8')

  if (sniffMime(bytes).mime !== 'image/svg+xml') {
    throw new SvgSanitisationError(
      'The sanitised document is no longer recognisable as an SVG',
    )
  }

  return { svg: bytes, removed }
}
