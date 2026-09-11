/**
 * Link classification.
 *
 * Two questions, deliberately not one, because the answers differ:
 *
 *   - *Does this link leave our origin?* — decides `target` and `rel`. True for
 *     `mailto:` and `tel:` too, since handing the click to the OS is still a
 *     departure and `noopener` costs nothing.
 *   - *Is this a link to another website?* — decides whether to show the "opens
 *     elsewhere" affordance. False for `mailto:`, `tel:` and `data:`, where a
 *     ↗ arrow would be noise pointing at a mail client.
 *
 * Collapsing these into one predicate is how a mailto ends up wearing a
 * "leaves the site" marker, which is technically true and useless to a reader.
 */

/** A URL carrying an explicit scheme, e.g. `https:`, `mailto:`, `tel:`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** The two schemes that name another web origin. */
const WEB_SCHEME = /^https?:/i

const BACKSLASH = /\\/g

/**
 * Rewrite backslashes to forward slashes.
 *
 * Browsers treat the two as equivalent for special schemes, which is a genuine
 * security-relevant quirk rather than a formatting nicety: `/\evil.com` and
 * `\\evil.com` are read as `//evil.com` and navigate off-origin, while looking
 * convincingly like a local path. A predicate that tests the raw string calls
 * them internal and hands them to `next/link` — a prefetch and a client-side
 * navigation aimed at something that is not a route.
 *
 * Normalising first is what makes the answer match what the browser will
 * actually do, which is the only answer that matters here.
 */
function slashesNormalized(href: string): string {
  return href.includes('\\') ? href.replace(BACKSLASH, '/') : href
}

/**
 * Has a scheme, or is protocol-relative (`//host/path`).
 *
 * A single leading slash is a path on this site and is explicitly not matched.
 * Matching it is the classic bug that sends internal links out of the SPA and
 * wraps them in `target="_blank"`.
 */
export function isAbsoluteHref(href: string): boolean {
  const normalized = slashesNormalized(href)
  return SCHEME.test(normalized) || normalized.startsWith('//')
}

/** Points at another website, over http or https. */
export function isExternalWebHref(href: string): boolean {
  const normalized = slashesNormalized(href)
  return WEB_SCHEME.test(normalized) || normalized.startsWith('//')
}
