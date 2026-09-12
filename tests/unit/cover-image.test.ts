import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CoverImage } from '@/components/content/cover-image'
import type { DocumentImage } from '@/lib/markdown/rehype-enhance'

/**
 * The cover's markup.
 *
 * `CoverImage` is a plain function component with no hooks, rendered through
 * `createElement` rather than JSX because the unit suite's `include` is
 * `tests/unit/**\/*.test.ts` — a `.tsx` file here would not be picked up.
 *
 * ## Why the attributes below are spelled in camelCase
 *
 * `renderToString` is React's Fizz renderer, the one the App Router uses, and
 * it emits React's own prop names for `srcSet` and `fetchPriority` rather than
 * the HTML spellings — verified against Fizz and the legacy renderer, which
 * agree. That is not the defect it looks like: HTML attribute names are
 * case-insensitive, so a browser parses `srcSet="…"` as the `srcset` attribute
 * and reads the `<source>` correctly.
 *
 * The body's images come through `rehype-stringify` instead, which emits
 * lowercase, so the two spellings do appear side by side in one document. The
 * assertions here are written against what React actually produces, because a
 * test asserting the tidier spelling would pass here and prove nothing about
 * the page.
 *
 * ## What is worth pinning
 *
 * The parts that differ from the body's images: this one loads eagerly, and it
 * decides for itself what to leave out when the asset row is missing.
 * Everything else it does, it does to match the pipeline.
 */

const STORED: DocumentImage = {
  width: 1200,
  height: 630,
  sources: [
    { type: 'image/avif', url: '/uploads/ab/ab/hash.avif' },
    { type: 'image/webp', url: '/uploads/ab/ab/hash.webp' },
  ],
  blurDataUrl: `data:image/webp;base64,${'A'.repeat(48)}`,
}

const href = '/uploads/ab/ab/hash.png'

function render(image: DocumentImage | null, url = href): string {
  return renderToString(createElement(CoverImage, { href: url, image }))
}

describe('CoverImage', () => {
  it('offers the formats the asset is stored in, and keeps the original', () => {
    const html = render(STORED)

    expect(html).toContain('<picture>')
    expect(html).toContain('type="image/avif"')
    expect(html).toContain('srcSet="/uploads/ab/ab/hash.avif"')
    expect(html).toContain('type="image/webp"')
    expect(html).toContain('srcSet="/uploads/ab/ab/hash.webp"')

    // Best codec first, because a browser takes the first `<source>` it
    // understands and AVIF is the smaller of the two at equal quality.
    expect(html.indexOf('image/avif')).toBeLessThan(html.indexOf('image/webp'))

    // The `<img>` stays the stored original, exactly as the body's images do —
    // a `<source>` is an offer, and the fallback has to be the file that is
    // certain to be there.
    expect(html).toContain(`src="${href}"`)
    expect(html).not.toContain('src="/uploads/ab/ab/hash.webp"')
  })

  it('reserves the box from the row', () => {
    const html = render(STORED)

    expect(html).toContain('width="1200"')
    expect(html).toContain('height="630"')
  })

  it('loads eagerly and at high priority', () => {
    const html = render(STORED)

    // The one deliberate difference from every image inside an article, which
    // are all lazy. A cover is the page's lead image, so deferring it defers
    // the thing the reader is waiting for.
    expect(html).toContain('loading="eager"')
    expect(html).toContain('fetchPriority="high"')
    expect(html).not.toContain('loading="lazy"')
  })

  it('declares no alt text, because the title directly above it says the same thing', () => {
    expect(render(STORED)).toContain('alt=""')
  })

  it('renders a bare img when the asset is not ours', () => {
    const html = render(null, 'https://example.com/hero.png')

    // No row means no dimensions and no alternatives — but the picture is still
    // the author's and still has to appear.
    expect(html).toContain('src="https://example.com/hero.png"')
    expect(html).not.toContain('<picture>')
    expect(html).not.toContain('<source')
    expect(html).not.toContain('width=')
    expect(html).not.toContain('height=')
  })

  it('leaves out a dimension the row does not know', () => {
    // A half-known size is worse than an unknown one: the browser would reserve
    // a box of the right width and the wrong height, then shift the page when
    // the real one arrives.
    const half = render({ width: 800, height: null, sources: [], blurDataUrl: null })

    expect(half).toContain('width="800"')
    expect(half).not.toContain('height=')
  })

  it('renders no picture when the row holds no other formats', () => {
    // A small image whose derivatives were all larger, which the store keeps
    // only when they are strictly smaller. An empty `<picture>` would be a
    // wrapper earning nothing.
    const html = render({ width: 90, height: 90, sources: [], blurDataUrl: null })

    expect(html).toContain(`src="${href}"`)
    expect(html).not.toContain('<picture>')
  })

  it('paints the stored placeholder into the box the row sized', () => {
    const html = render(STORED)

    // The same custom property the body's images carry, and the same rule in
    // `globals.css` consuming it — the cover is the image that gains the most
    // from it, since it is the largest thing on the page. It goes on the
    // `<img>`, whose box `width`/`height` sized, rather than on the container:
    // the container is as wide as the column, and a narrow cover would get a
    // placeholder wider than the picture.
    expect(html).toContain(`style="--md-blur:url(${STORED.blurDataUrl})"`)
    // The container tag exactly as written, with nothing after the class — so
    // the property is on the image and nowhere else.
    expect(html).toContain(`<div class="md-cover mb-10">`)
  })

  it('paints nothing when the row holds no placeholder', () => {
    // An SVG has none by construction, and neither has a row written before
    // the placeholder existed. Absent has to mean the attribute is absent: an
    // empty custom property is still a `style` attribute in the served HTML.
    const html = render({ width: 90, height: 90, sources: [], blurDataUrl: null })

    expect(html).not.toContain('--md-blur')
    expect(html).not.toContain('style=')
  })

  it('refuses a placeholder that is not a data URI this site writes', () => {
    // The column is a text field, so the guard runs here rather than trusting
    // the row: a remote URL would be a request every reader's browser makes,
    // and a `;` in the value would end the declaration and start another.
    const hostile = render({
      width: 1200,
      height: 630,
      sources: [],
      blurDataUrl: 'data:image/webp;base64,AAAA;background-image:url(https://example.com/p.png)',
    })
    const remote = render({
      width: 1200,
      height: 630,
      sources: [],
      blurDataUrl: 'https://example.com/p.png',
    })

    for (const html of [hostile, remote]) {
      expect(html).not.toContain('--md-blur')
      expect(html).not.toContain('style=')
      expect(html).not.toContain('example.com')
      // The cover itself is unaffected — the placeholder is an improvement, and
      // losing one is not a reason to render the image differently.
      expect(html).toContain(`src="${href}"`)
    }
  })
})
