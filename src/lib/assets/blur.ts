/**
 * The blur placeholder: how small one has to be, and when one may be painted.
 *
 * This module exists because the two halves of that idea live on opposite sides
 * of a dependency. `process.ts` writes a placeholder with sharp and may import
 * anything it likes; the renderer paints one while it serves a page, and it
 * must not reach sharp to ask whether a string is safe to write into a `style`
 * attribute. The rules are one idea, so they are in one file that imports
 * nothing at all — the encoder reads the budget, the renderer reads the guard,
 * and neither can drift from the other.
 *
 * What a placeholder is *for* is the third thing here, and it is the reason the
 * guard is strict: the value is inlined in the HTML of every page that shows
 * the asset, so it is paid for on the critical path, and it is a URL, so
 * painting one is a request somebody's browser makes.
 */

/* -------------------------------------------------------------------------- */
/*  The encoder's budget                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Long edge of the blur placeholder, in pixels.
 *
 * The placeholder is stretched to the full display size by the browser, so it
 * only has to carry the composition — 20px on the long edge does that at a
 * payload measured in tens of bytes. Bigger stops being a placeholder and
 * becomes a second download.
 */
export const BLUR_LONG_EDGE = 20

/**
 * Ceiling on the placeholder's data URI.
 *
 * A data URI is inlined in the HTML of every page that shows the asset, so its
 * size is paid on the critical path. Past this it costs more than the layout
 * shift it prevents, and the honest answer is no placeholder at all.
 */
export const BLUR_MAX_DATA_URL_LENGTH = 2048

/* -------------------------------------------------------------------------- */
/*  The renderer's guard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The custom property a placeholder is carried in.
 *
 * Inline, because it is a value rather than a rule — the stylesheet owns what
 * `background-image` does with it, the same division `--md-columns` uses.
 */
export const BLUR_PROPERTY = '--md-blur'

/**
 * The one shape a placeholder may have.
 *
 * A `data:` URI of an image, base64, and nothing else. Each clause refuses
 * something specific:
 *
 * - **`data:`** — a `url(https://…)` here is a request every reader's browser
 *   makes to somebody else's server, which is the address leak this project
 *   refuses everywhere else; a placeholder that has to be fetched to be shown
 *   is also not a placeholder, since it arrives at the same time as the image.
 * - **base64** — a percent-encoded value can carry the CSS punctuation that
 *   would end the declaration, and a `style` attribute is a declaration list:
 *   a `;` in the value would make whatever follows it a declaration of its own.
 * - **the character set** — standard base64 only. The encoder writes that
 *   alphabet (`process.ts`), so anything else is a value this site did not
 *   produce, and a refusal here costs a placeholder rather than a page. It is
 *   deliberately narrower than the CSS grammar would allow, so that widening it
 *   is a decision somebody makes rather than something that happens.
 *
 * Anchored at both ends: a value that merely *contains* a data URI is not one.
 */
const PLACEHOLDER_SHAPE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i

/**
 * A stored placeholder as a CSS `url(…)`, or null when it may not be painted.
 *
 * The length is checked before the shape, because the ceiling is a comparison
 * and the shape is a scan: a row edited by hand to hold a megabyte of text is
 * refused by the cheaper test, and the expensive one only ever runs on a value
 * that is already known to be short.
 *
 * Null is a normal answer, not an error. Every raster the pipeline stores has a
 * placeholder, but the column is nullable, an SVG has none by construction, and
 * a row written by an older build or by hand may hold anything at all. All of
 * those are images that load without a placeholder — which is what the site did
 * before this was painted — so the caller renders the image and says nothing.
 */
export function blurPlaceholderSource(value: string | null | undefined): string | null {
  if (!value) return null
  if (value.length > BLUR_MAX_DATA_URL_LENGTH) return null
  if (!PLACEHOLDER_SHAPE.test(value)) return null
  return `url(${value})`
}
