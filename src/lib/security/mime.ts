/**
 * Content-type detection from magic bytes.
 *
 * The `Content-Type` header and the file extension are both attacker-controlled.
 * Sniffing the bytes is the only claim we can act on, and the extension we store
 * is derived from the sniff rather than from the upload's own filename.
 */

export interface SniffResult {
  mime: string
  ext: string
  /** False for anything we will not serve inline. */
  allowed: boolean
}

/** Formats the asset manager accepts. SVG is handled separately (sanitised). */
const IMAGE_SIGNATURES: {
  mime: string
  ext: string
  test: (b: Buffer) => boolean
}[] = [
  {
    mime: 'image/png',
    ext: '.png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    ext: '.jpg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/gif',
    ext: '.gif',
    test: (b) =>
      b.length >= 6 &&
      b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null,
  },
  {
    // RIFF....WEBP
    mime: 'image/webp',
    ext: '.webp',
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    // ....ftypavif / ....ftypavis  (ISO-BMFF box at offset 4)
    mime: 'image/avif',
    ext: '.avif',
    test: (b) =>
      b.length >= 12 &&
      b.subarray(4, 8).toString('latin1') === 'ftyp' &&
      ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1')),
  },
  {
    mime: 'image/bmp',
    ext: '.bmp',
    test: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d,
  },
  {
    mime: 'image/tiff',
    ext: '.tiff',
    test: (b) =>
      b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)),
  },
  {
    mime: 'video/mp4',
    ext: '.mp4',
    test: (b) =>
      b.length >= 12 &&
      b.subarray(4, 8).toString('latin1') === 'ftyp' &&
      ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash'].includes(
        b.subarray(8, 12).toString('latin1'),
      ),
  },
  {
    mime: 'video/webm',
    ext: '.webm',
    test: (b) =>
      b.length >= 4 &&
      b[0] === 0x1a &&
      b[1] === 0x45 &&
      b[2] === 0xdf &&
      b[3] === 0xa3,
  },
  {
    mime: 'application/pdf',
    ext: '.pdf',
    test: (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
]

/**
 * Detect the type of `buffer`.
 *
 * SVG is XML with no fixed signature, so it is recognised structurally: an
 * optional XML declaration, optional comments/doctype, then a `<svg` root. The
 * parsed result is *not* trusted — `sanitizeSvg` must still run before storage.
 */
export function sniffMime(buffer: Buffer): SniffResult {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.test(buffer)) {
      return { mime: sig.mime, ext: sig.ext, allowed: true }
    }
  }

  if (looksLikeSvg(buffer)) {
    return { mime: 'image/svg+xml', ext: '.svg', allowed: true }
  }

  return { mime: 'application/octet-stream', ext: '.bin', allowed: false }
}

function looksLikeSvg(buffer: Buffer): boolean {
  // Only the head can contain the prologue; scanning a whole 20 MB file for
  // '<svg' would let a binary with an incidental match through.
  const head = buffer.subarray(0, 4096).toString('utf8')
  // `/` belongs in the tag-boundary class: `<svg/>` is a valid (empty) SVG
  // document, and the class is only there to stop `<svgfoo` from matching.
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)*<svg[\s/>]/i.test(
    head,
  )
}

/* -------------------------------------------------------------------------- */
/*  SVG sanitisation                                                           */
/* -------------------------------------------------------------------------- */

/** Elements that can execute or fetch. Dropped entirely, children included. */
const DANGEROUS_SVG_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'embed',
  'object',
  'use',
  'animate',
  'animateTransform',
  'animateMotion',
  'set',
  'handler',
]

export interface SvgSanitizeResult {
  svg: string
  removed: string[]
}

/**
 * URL-bearing attributes, value and quotes included, screened for schemes.
 *
 * The value is captured so the decision can be made about it alone; the whole
 * match is what gets removed.
 */
const URL_ATTRIBUTES =
  /\s(?:xlink:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/**
 * Values that turn an attribute into script or into a second document.
 *
 * Anchored to the scheme. An unanchored search would delete
 * `href="images/javascript-logo.png"` — a perfectly ordinary relative path that
 * happens to contain the word — and a sanitizer that quietly drops legitimate
 * artwork is a sanitizer people turn off.
 */
const SCRIPT_URL =
  /^(?:javascript:|vbscript:|data:text\/html(?:[;,]|$))/i

/** Whitespace and control characters, which a scheme may hide behind. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/g

/**
 * True when a decoded attribute value is a script URL.
 *
 * Whitespace and control characters are stripped first because browsers strip
 * them too: `java\nscript:alert(1)` runs, so a check that stops at the first
 * line break is not a check.
 */
function isScriptUrl(value: string): boolean {
  const stripped = decodeCharRefs(value).replace(CONTROL_OR_SPACE, '')
  return SCRIPT_URL.test(stripped)
}

/**
 * Embedded raster images, which are self-contained and cannot phone home.
 *
 * `data:image/svg+xml` is deliberately absent: it is another SVG, so its
 * contents are only as trustworthy as this function, and nesting the problem
 * inside an attribute is not something worth supporting for an icon library.
 */
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i

/** Any absolute URL scheme, including the protocol-relative `//host/path`. */
const ABSOLUTE_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * Decide whether a reference leaves our origin.
 *
 * Protocol-relative matters as much as `https:`: `//evil.test/track.png` is
 * fetched from the reader's browser exactly like the explicit form, and it was
 * the shape that slipped past a literal `https?://` check. A same-document
 * fragment and an ordinary relative path stay — they resolve inside the asset
 * directory and reveal nothing.
 */
function leaksToAnotherOrigin(value: string): boolean {
  const decoded = decodeCharRefs(value).trim()
  if (!decoded || decoded.startsWith('#')) return false
  if (EMBEDDED_IMAGE.test(decoded)) return false
  return ABSOLUTE_REFERENCE.test(decoded)
}

/**
 * Decode numeric character references.
 *
 * `&#106;avascript:alert(1)` is `javascript:alert(1)` once the XML parser has
 * read the attribute, so the screening below has to look at the decoded value.
 */
function decodeCharRefs(value: string): string {
  return value.replace(
    /&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi,
    (match, hex: string | undefined, decimal: string | undefined) => {
      const code = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10)
      if (!Number.isFinite(code) || code > 0x10ffff) return match
      return String.fromCodePoint(code)
    },
  )
}

/**
 * Reduce an SVG to static geometry.
 *
 * SVG is the one "image" format that is also a full script host: it can carry
 * `<script>`, `on*` handlers, and external references that leak the reader's IP.
 * Since the asset manager serves these from our own origin, an unsanitised SVG
 * is stored XSS.
 *
 * This is a **blocklist over the known-dangerous shapes**, not an allow-list
 * over the known-safe ones, and the difference matters. The shapes below cover
 * every markup-level route to script execution; there is no SVG parser here, so
 * an element type nobody thought of would pass through. Treat the output as
 * "no longer an obvious script host" rather than as "provably inert", and keep
 * serving SVGs with `Content-Security-Policy: default-src 'none'; sandbox`,
 * which is what actually makes a surviving trick harmless.
 */
export function sanitizeSvg(source: string): SvgSanitizeResult {
  const removed: string[] = []
  let out = source

  out = stripBlocks(out, 'script', removed)
  out = stripBlocks(out, 'foreignObject', removed)
  out = stripBlocks(out, 'style', removed)
  out = stripBlocks(out, 'iframe', removed)
  out = stripBlocks(out, 'embed', removed)
  out = stripBlocks(out, 'object', removed)

  for (const tag of DANGEROUS_SVG_ELEMENTS) {
    if (tag === 'script' || tag === 'foreignObject' || tag === 'iframe' ||
        tag === 'embed' || tag === 'object') {
      continue
    }
    const re = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi')
    if (re.test(out)) {
      removed.push(tag)
      out = out.replace(re, '')
    }
  }

  // Event handlers: onload=, onclick=, and friends. The leading class also
  // allows `/`, because `<svg/onload=…>` is parsed as an attribute by the HTML
  // parser — and a sanitised icon is exactly the kind of markup that ends up
  // inlined into a page.
  if (/(?:^|[\s/])on[a-z]+\s*=/i.test(out)) {
    removed.push('event handler attributes')
    out = out.replace(
      /(?:^|[\s/])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      '',
    )
  }

  // One pass over every URL-bearing attribute, because the two questions —
  // "is this script?" and "does this leave our origin?" — have to be asked of
  // the same decoded value, and asking them in separate passes means the second
  // pass re-parses what the first one already rewrote.
  //
  // Decoding first is what makes it work: `&#106;avascript:` *is*
  // `javascript:` to the XML parser, so screening the literal text evades it.
  out = out.replace(URL_ATTRIBUTES, (match, doubleQuoted, singleQuoted, bare) => {
    const value: string = doubleQuoted ?? singleQuoted ?? bare ?? ''

    if (isScriptUrl(value)) {
      removed.push('javascript: URL')
      return ''
    }
    if (leaksToAnotherOrigin(value)) {
      removed.push('external reference')
      return ''
    }
    return match
  })

  // XML processing instructions other than the declaration, plus DOCTYPE
  // (which can define entities that expand into markup).
  out = out.replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '')
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '')

  return { svg: out.trim(), removed: [...new Set(removed)] }
}

/** Remove `<tag …>…</tag>` blocks and any self-closing/void forms. */
function stripBlocks(source: string, tag: string, removed: string[]): string {
  const paired = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi')
  const unpaired = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi')

  let out = source
  if (paired.test(out)) {
    removed.push(tag)
    out = out.replace(paired, '')
  }
  if (unpaired.test(out)) {
    if (!removed.includes(tag)) removed.push(tag)
    out = out.replace(unpaired, '')
  }
  return out
}

/**
 * Validate that a string is a hex colour before it is interpolated into CSS.
 * Tag colours come from the admin and reach a `style` attribute.
 */
export function isSafeHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
}
