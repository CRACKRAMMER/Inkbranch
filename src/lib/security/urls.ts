import { z } from 'zod'

/**
 * URL and path validation.
 *
 * Every stored href — navigation items, redirect sources and targets, avatar
 * URLs, about-page links — is validated here before it reaches the database,
 * and stored values are rendered into an `href` attribute by the reading
 * experience. That makes this module a stored-XSS boundary: a `javascript:`
 * href that reaches the database is only stopped by whatever React or a
 * sanitiser happens to do downstream, and neither is a contract.
 *
 * The checks are deliberately about the *shape* of the string rather than
 * about a URL parser's opinion of it. A stored path is not resolved against
 * anything; it is compared, byte for byte, to a request path.
 */

/**
 * Longest href any of the consuming columns accepts (`varchar(512)`).
 *
 * One limit for every consumer rather than one per caller. The columns that
 * hold these values — `navigation.href`, `redirects.from_path` and `to_path`,
 * `site_settings.avatar_url` — are all `varchar(512)`, and the two About-page
 * links live in a jsonb column bounded by nothing but this. A caller passing a
 * tighter limit would be enforcing a rule the database does not have, and the
 * value it refused would have been storable.
 */
const MAX_URL_LENGTH = 512

/** Whitespace, by the same definition `\s` uses in a regular expression. */
const WHITESPACE = /\s/

/**
 * True for the characters that make a stored href ambiguous: the C0 controls,
 * DEL, and anything Unicode calls whitespace.
 *
 * Written as a character test rather than a character class so the source file
 * does not have to contain the control characters it is rejecting.
 */
function hasUnsafeChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || WHITESPACE.test(char)) return true
  }
  return false
}

/**
 * Why `value` cannot be a site-relative path, or `null` when it can.
 *
 * Returned as a reason rather than a boolean so the Zod schemas below can put
 * it in a field error; a bare predicate would need the same rules written
 * twice, once as a check and once as prose.
 */
export function internalPathProblem(value: string): string | null {
  if (!value) return 'Path is empty'
  if (value.length > MAX_URL_LENGTH) {
    return `Path is longer than ${MAX_URL_LENGTH} characters`
  }
  if (hasUnsafeChar(value)) {
    return 'Path contains whitespace or control characters'
  }
  if (!value.startsWith('/')) return 'Site-relative paths must start with /'

  // `//host/path` and `/\host/path` are both read by browsers as protocol
  // relative — they resolve to `https://host/path`, not to a path on this site.
  // The backslash is not decoration: in the WHATWG URL parser `\` is a `/` for
  // any special scheme, so `/\evil.com` navigates off-site just as `//evil.com`
  // does.
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return 'Path must not be protocol-relative'
  }
  if (value.includes('\\')) return 'Path must not contain a backslash'

  // Rejected rather than resolved. A path that climbs is a bug in whatever
  // produced it, and normalising it here would hide the bug while quietly
  // changing which URL the row matches.
  if (value.split(/[/?#]/).includes('..')) {
    return 'Path must not contain a ".." segment'
  }

  // Encoded dots are normalized by the URL parser too. Double encoding can
  // pass through a proxy and router in separate decoding steps, so screen both
  // forms before storing a path used by metadata or an HTTP redirect.
  let decoded = value.split(/[?#]/)[0] ?? value
  for (let pass = 0; pass < 2; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break // A literal percent has no decoded traversal to check.
    }
    if (next === decoded) break
    decoded = next
    if (decoded.split('/').includes('..') || decoded.includes('\\') || decoded.startsWith('//')) {
      return 'Path contains encoded traversal or separators'
    }
  }

  return null
}

/**
 * A line break in a `mailto:` header, raw or percent-encoded.
 *
 * The mailto grammar puts extra headers after `?`, so a decoded CRLF is how a
 * link that looks like it opens a composer also adds a `Bcc:` to the message.
 * A mail client decodes the percent-escapes before it reads the headers, which
 * is why the encoded form is refused alongside the literal one.
 */
const MAILTO_HEADER_INJECTION = /%0d|%0a|[\r\n]/i

export interface ExternalUrlOptions {
  /**
   * Accept `mailto:` as well as http(s).
   *
   * Off by default. Where a URL is a place a browser sends the reader — a
   * navigation href, a link on the About page — a mail client is a reasonable
   * destination. Where it is a value a browser *fetches* or *follows* — an
   * avatar image, an HTTP `Location` header — it is not.
   */
  allowMailto?: boolean
}

/**
 * Why `value` cannot be an absolute URL of an allowed scheme, or `null` when it
 * can.
 *
 * `tel:`, `data:` and `ftp:` are refused even where `mailto:` is allowed, and
 * `data:` is the reason the list stays an allow-list: `data:text/html` is a
 * script execution with a URL for a wrapper.
 */
export function externalUrlProblem(
  value: string,
  options: ExternalUrlOptions = {},
): string | null {
  if (!value) return 'URL is empty'
  if (value.length > MAX_URL_LENGTH) {
    return `URL is longer than ${MAX_URL_LENGTH} characters`
  }
  if (hasUnsafeChar(value)) {
    return 'URL contains whitespace or control characters'
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // `new URL` throws on anything it cannot parse, which is every string that
    // is not an absolute URL. The throw is the answer, not an error to report.
    return 'Not a valid absolute URL'
  }

  const scheme = parsed.protocol.replace(':', '')

  if (scheme === 'mailto') {
    if (!options.allowMailto) {
      return 'A mailto link is not allowed here'
    }
    const address = value.slice(value.indexOf(':') + 1)
    if (!address) return 'A mailto link needs an address after mailto:'
    if (MAILTO_HEADER_INJECTION.test(address)) {
      return 'A mailto link must not contain a line break'
    }
    return null
  }

  if (scheme !== 'http' && scheme !== 'https') {
    const allowed = options.allowMailto ? 'http, https or mailto' : 'http or https'
    return `URL scheme must be ${allowed}, not ${scheme}`
  }
  if (!/^https?:\/\//i.test(value) || value.includes('\\')) {
    return 'HTTP URLs must start with http:// or https:// and contain no backslash'
  }
  if (!parsed.hostname) return 'URL must name a host'

  return null
}

/**
 * True only for http(s) — the strict reading, for a URL a browser fetches.
 *
 * The predicate form, for the one caller that needs to branch on the answer
 * rather than to report it: `redirects.ts` reads `to_path` back out of the
 * database and decides whether a stored target is a path to normalise or a URL
 * to follow. Everywhere a value is being *accepted from a form*, the schemas
 * below are the ones to use — they carry the reason into the field error.
 */
export const isExternalUrl = (value: string): boolean =>
  externalUrlProblem(value) === null

/* -------------------------------------------------------------------------- */
/*  Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A site-relative path or an absolute http(s) URL.
 *
 * The narrower of the two link schemas: for a column whose value the browser
 * fetches as a resource rather than navigates to.
 */
export const internalOrExternalUrlSchema = z
  .string()
  .trim()
  .refine(
    (value) => internalPathProblem(value) === null || externalUrlProblem(value) === null,
    'Must be a site-relative path starting with / or an absolute http(s) URL',
  )

/**
 * A site-relative path, an absolute http(s) URL, or a `mailto:` link.
 *
 * For a link the reader clicks: a contact address belongs on an About page, and
 * there is no honest way to put one there without a mailto.
 */
export const linkHrefSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      internalPathProblem(value) === null ||
      externalUrlProblem(value, { allowMailto: true }) === null,
    'Must be a site-relative path starting with /, an absolute http(s) URL, or a mailto: link',
  )

/**
 * Why an href cannot be used for an item that claims to be `external`, or
 * `null` when it can.
 *
 * The flag and the href have to agree. An item marked internal whose href is
 * `https://example.com` would be rendered without `target="_blank"` and without
 * `rel="noopener noreferrer"`, handing the target page a `window.opener`
 * handle; an item marked external whose href is `/about` opens the site in a
 * new tab for no reason. `mailto:` counts as external: it leaves the browser,
 * but it is not another web origin, so a renderer that distinguishes the two
 * still has what it needs.
 */
export function hrefKindProblem(href: string, external: boolean): string | null {
  return external
    ? externalUrlProblem(href, { allowMailto: true })
    : internalPathProblem(href)
}
