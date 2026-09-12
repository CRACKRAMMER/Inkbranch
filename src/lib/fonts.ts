/**
 * The fonts the site preloads, named here by hand.
 *
 * ## Why the filenames are written out
 *
 * `next/font` is supposed to emit these hints itself. It builds a manifest
 * mapping each page to the font files that page needs, and then
 * `getPreloadableFonts` looks that entry up by page path to render the
 * `<link rel="preload">` — and the lookup misses. Turbopack writes the manifest
 * keys namespaced, as `[project]/src/app/(site)/page`, while the renderer
 * passes the bare path, so the entry is never found, no preload is emitted, and
 * — because the same `null` is what suppresses the alternative — not even the
 * origin preconnect a page with no fonts would get. `next build` says nothing
 * about it; the served HTML simply has no font hint in it.
 *
 * The manifest is not merely keyed wrongly, it is also flattened: every one of
 * the thirty-odd routes in this build lists the same single Inter file, so even
 * a corrected lookup would have nothing per-page to find.
 *
 * ## What that costs
 *
 * One round trip of discovery on every page. The browser cannot know it needs a
 * family until it has parsed the stylesheet, by which point it has painted in
 * the fallback and is waiting to swap. Preloading puts the request in flight at
 * the same time as the CSS.
 *
 * `scripts/check/font-preload.ts` runs after every build and fails it if either
 * file below is no longer one the build produced — the names are content-hashed,
 * so they change when a font option does, and a stale value here would be a 404
 * on every page that names it and nothing louder than a console warning.
 *
 * ## Why there are two, and which page gets which
 *
 * A preload is a promise that a resource is needed for the first paint, and the
 * promise is kept on every page that emits it. So each entry here is claimed
 * only by the pages that will actually paint in that family:
 *
 *   `ui`     Inter, which sets the chrome — header, navigation, metadata,
 *            lists. Every page in the site paints it, so `layout.tsx` emits it
 *            once for all of them.
 *   `prose`  Source Serif 4, the article face. Only a document route renders
 *            prose, and all three of them do it through `ArticleBody`, so that
 *            is where the hint is emitted — a tag list or the archive has no
 *            article on it and pays nothing for this.
 *
 * The mono face is deliberately absent. Code is never the first thing on a page
 * here; a fence is always below a title and a lead paragraph, so a preload for
 * JetBrains Mono would be a promise kept on pages that do not need it and
 * broken on the ones that do.
 *
 * These are constants and not something computed because the hashed filename is
 * Next's to choose and the only way to learn it is to ask a finished build. The
 * site is served from a domain root — `next.config.ts` sets no `basePath` and no
 * `assetPrefix` — so these root-relative URLs are also exactly the ones the
 * stylesheet will request, and a preload warms the request rather than
 * duplicating it.
 */

/** One preloadable file, as the `<link>` needs to describe it. */
export interface FontPreload {
  href: string
  type: string
}

/**
 * Inter, the interface face, painted by every page in the site.
 *
 * The `.p.` in the filename is Next's own marking of the subset it considered
 * primary; the other families' files do not carry it, which is the flattened
 * manifest's other symptom.
 */
export const UI_FONT: FontPreload = {
  href: '/_next/static/media/83afe278b6a6bb3c-s.p.2bn3s6zvc0dyp.woff2',
  type: 'font/woff2',
}

/** Source Serif 4, the article face, painted only by a document body. */
export const PROSE_FONT: FontPreload = {
  href: '/_next/static/media/68d403cf9f2c68c5-s.20at88_q9f_kt.woff2',
  type: 'font/woff2',
}

/** Both, for the build check that has to know every filename the site names. */
export const PRELOADED_FONTS: Record<string, FontPreload> = {
  ui: UI_FONT,
  prose: PROSE_FONT,
}
