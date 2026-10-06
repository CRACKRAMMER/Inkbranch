import { getFontPreload } from '@/lib/font-preloads'
import type { FontRole } from '@/lib/fonts'

/**
 * A font hint, rendered from wherever the font is first painted.
 *
 * `next/font` is supposed to write these and does not — `src/lib/fonts.ts` has
 * the whole of that. What matters here is where the element may be rendered
 * from: React 19 hoists a `<link>` out of the tree and into `<head>`, so a
 * component three levels into a page can still put the hint where it is useful,
 * and the hint can be scoped to the pages that need it by being rendered only
 * by those pages. That is what lets the article face be preloaded on a document
 * page and cost nothing on the archive.
 *
 * `crossOrigin` is not optional on a font preload even same-origin: fonts are
 * fetched in CORS mode, and a preload without it warms a request the stylesheet
 * will then make again.
 */
export function FontPreloadLink({ font: role }: { font: FontRole }) {
  const font = getFontPreload(role)
  if (!font) return null
  return (
    <link rel="preload" as="font" type={font.type} crossOrigin="anonymous" href={font.href} />
  )
}
