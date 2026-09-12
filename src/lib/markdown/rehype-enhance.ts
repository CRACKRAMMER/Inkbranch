import { toString as hastToString } from 'hast-util-to-string'
import type { Element, ElementContent, Root } from 'hast'
import { visit } from 'unist-util-visit'
import { BLUR_PROPERTY, blurPlaceholderSource } from '@/lib/assets/blur'
import { isAllowedEmbed } from '@/lib/security/embed-origins'
import { isExternalWebHref } from '@/lib/utils/url'
import { HeadingSlugger } from './slugger'

/**
 * Structural enhancement pass.
 *
 * Runs after sanitisation and before the highlighter. Everything it emits is
 * therefore this project's own markup rather than the author's — which is the
 * reason it may emit a `<picture>` that the sanitiser's allow-list does not
 * carry, and the reason nothing here has to be sanitised again.
 *
 * What it does is additive: heading anchors, table scroll wrappers, link
 * rel/target policy, image loading hints, intrinsic image sizes, the formats an
 * image is also stored in, and the placeholder it is stored with. The one thing
 * it removes is an `<iframe>` whose origin is not on the allow-list.
 */

export interface EnhanceOptions {
  /** Origins permitted inside an `<iframe>`. Anything else is dropped. */
  allowedEmbedOrigins: readonly string[]
  /** When set, internal document links are checked against known slugs. */
  knownSlugs?: ReadonlySet<string>
  /** What is known about the site's own images, keyed by `src` as written. */
  images?: ReadonlyMap<string, DocumentImage>
}

/**
 * What is known about one of the site's own images.
 *
 * Supplied by the caller, because this pass has no database to ask. The caller
 * already walks a document for its image references — the sync engine does it
 * for "which articles use this image" — and hands the answer in as a map.
 *
 * An image the map does not mention is rendered exactly as it was written. The
 * map is an improvement and never a requirement, which is what keeps an
 * external image, a reference-style one the scanner did not resolve, or an
 * asset whose row has been deleted from being mangled by not being found.
 */
export interface DocumentImage {
  /** Intrinsic size of the stored original, when the row knows it. */
  width: number | null
  height: number | null
  /** The same picture in other formats, most preferred first. */
  sources: readonly ImageSource[]
  /**
   * The placeholder the pipeline stored for it, or null when it has none.
   *
   * Raw as the row holds it: this pass is where it becomes markup, and
   * `blurPlaceholderSource` decides there whether it may be painted. A cover is
   * handed the same value and answers the same question the same way.
   */
  blurDataUrl: string | null
}

/** One entry of a `<picture>`'s `<source>` list. */
export interface ImageSource {
  /** A media type, e.g. `image/avif`. */
  type: string
  url: string
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export function rehypeEnhance(options: EnhanceOptions) {
  return (tree: Root): void => {
    const slugger = new HeadingSlugger()

    // The slugger must see headings in document order, so headings, tables,
    // links and images are collected in a single traversal rather than four.
    const tables: { parent: Element; index: number; node: Element }[] = []
    const iframes: { parent: Element; index: number; node: Element }[] = []
    const images: { parent: Element; index: number; node: Element }[] = []

    visit(tree, 'element', (node: Element, index, parent) => {
      if (!parent || index === undefined) return

      if (HEADING_TAGS.has(node.tagName)) {
        enhanceHeading(node, slugger)
        return
      }

      switch (node.tagName) {
        case 'table':
          tables.push({ parent: parent as Element, index, node })
          break
        case 'a':
          enhanceLink(node)
          break
        case 'img':
          enhanceImage(node, options.images?.get(imageSrc(node) ?? ''))
          images.push({ parent: parent as Element, index, node })
          break
        case 'iframe':
          iframes.push({ parent: parent as Element, index, node })
          break
        default:
          break
      }
    })

    // Tables scroll horizontally on narrow screens; the wrapper is what
    // receives the overflow, so the table itself keeps its natural width.
    for (const table of tables.reverse()) {
      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['md-table-wrap'],
          tabIndex: 0,
          role: 'region',
          ariaLabel: 'Table',
        },
        children: [table.node],
      }
      table.parent.children[table.index] = wrapper
    }

    for (const iframe of iframes.reverse()) {
      const src = typeof iframe.node.properties.src === 'string' ? iframe.node.properties.src : ''
      if (isAllowedEmbed(src, options.allowedEmbedOrigins)) continue
      // Drop disallowed embeds entirely rather than rendering a dead frame.
      iframe.parent.children.splice(iframe.index, 1)
    }

    wrapImages(images, options.images)

    if (options.knownSlugs) {
      markMissingTargets(tree, options.knownSlugs)
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Headings                                                                   */
/* -------------------------------------------------------------------------- */

function enhanceHeading(node: Element, slugger: HeadingSlugger): void {
  const text = hastToString(node)
  const id = slugger.slug(text)

  node.properties.id = id
  // Scroll-spy reads this; `scroll-margin-top` in CSS keeps the sticky header
  // from covering the heading when the anchor is followed.
  node.properties.dataHeading = id
  if (!node.properties.className) {
    node.properties.className = ['md-heading']
  }

  // A permalink that appears on hover, so headings are linkable without
  // adding a visible affordance that competes with the text.
  const anchor: Element = {
    type: 'element',
    tagName: 'a',
    properties: {
      className: ['md-heading__anchor'],
      href: `#${encodeURIComponent(id)}`,
      ariaLabel: `Link to ${text}`,
      tabIndex: -1,
    },
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { ariaHidden: 'true' },
        children: [{ type: 'text', value: '#' }],
      },
    ],
  }

  node.children.push(anchor)
}

/* -------------------------------------------------------------------------- */
/*  Links                                                                      */
/* -------------------------------------------------------------------------- */

function enhanceLink(node: Element): void {
  const href = typeof node.properties.href === 'string' ? node.properties.href : ''
  if (!href) return

  // Only links that navigate the browser to another *document* get the new-tab
  // treatment. `mailto:` and `tel:` are deliberately excluded: browsers honour
  // `target="_blank"` literally, so the reader gets a mail client *and* an
  // orphaned blank tab they have to close.
  if (isExternalWebHref(href)) {
    // `noopener` prevents the opened page from reaching back through
    // `window.opener`; `noreferrer` avoids leaking the article URL. They are
    // separate concerns, so both are set.
    node.properties.rel = ['noopener', 'noreferrer']
    node.properties.target = '_blank'

    // Signal to the reader (and to a screen reader) that this leaves the site.
    const classes = toClassList(node.properties.className)
    classes.push('md-link--external')
    node.properties.className = classes
  }

  if (href.startsWith('#')) {
    const classes = toClassList(node.properties.className)
    classes.push('md-link--anchor')
    node.properties.className = classes
  }
}

/**
 * Flag internal links whose target slug is not in the content index.
 *
 * Marking rather than rewriting: a broken link is the author's to fix, and
 * silently redirecting it would hide the problem. The admin's link checker
 * surfaces the same list.
 */
function markMissingTargets(tree: Root, knownSlugs: ReadonlySet<string>): void {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'a') return
    const href = typeof node.properties.href === 'string' ? node.properties.href : ''

    const match = /^\/(posts|notes|projects)\/([^/?#]+)/.exec(href)
    if (!match?.[1] || !match[2]) return

    let slug: string
    try {
      slug = decodeURIComponent(match[2])
    } catch {
      slug = match[2]
    }

    if (knownSlugs.has(`${match[1]}/${slug}`)) return

    const classes = toClassList(node.properties.className)
    classes.push('md-link--broken')
    node.properties.className = classes
    node.properties.dataBrokenTarget = `${match[1]}/${slug}`
  })
}

/* -------------------------------------------------------------------------- */
/*  Images                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Prepare an image for rendering.
 *
 * The wrapper is applied separately, after the traversal, because replacing a
 * node while `visit` is walking it is the classic way to produce a tree that
 * skips or duplicates siblings.
 */
function enhanceImage(node: Element, described: DocumentImage | undefined): void {
  // Native lazy loading costs nothing and defers offscreen diagrams. All images
  // are lazy, including the first: the layout reserves the space via the
  // wrapper's aspect ratio, so there is no content shift either way.
  node.properties.loading = 'lazy'
  node.properties.decoding = 'async'

  // An image with no alt text is inaccessible. An explicitly empty alt marks it
  // as decorative, which is the honest reading for a diagram whose explanation
  // is in the surrounding prose.
  if (node.properties.alt === undefined || node.properties.alt === null) {
    node.properties.alt = ''
  }

  /*
   * The intrinsic size, which is what lets the browser reserve the box before
   * the bytes arrive — without it, every diagram in an article shifts the text
   * below it as it loads. The figures come from the asset row rather than from
   * the file, so they describe the *stored* image: one the pipeline rotated is
   * reported as it will be displayed.
   *
   * An author's own width/height written into raw HTML is left alone. That is a
   * statement about how the image should be laid out, and this is a fact about
   * the file; the fact does not get to overwrite the statement.
   */
  if (described) {
    if (described.width !== null && node.properties.width === undefined) {
      node.properties.width = described.width
    }
    if (described.height !== null && node.properties.height === undefined) {
      node.properties.height = described.height
    }
  }

  /*
   * The placeholder, painted behind the image until its bytes arrive.
   *
   * It goes on the `<img>` rather than on the wrapper, because the box the
   * browser reserves from `width`/`height` above is exactly the box the picture
   * will occupy — so the composition is already in the right place, and the
   * image paints over it when it lands. A wrapper would be a second box to keep
   * in step with that one.
   *
   * The value comes from a database row, so it passes the guard in
   * `blurPlaceholderSource` before it is written anywhere: this attribute is
   * a CSS declaration list, and the row is not necessarily something this site
   * wrote. Null — an SVG, a row from before this was painted — is left out
   * entirely rather than written as an empty property.
   *
   * Appended rather than assigned: `style` is on the sanitiser's global
   * allow-list (`:::columns` and Shiki both depend on that), so the author may
   * already have declarations on this image, and they are not this pass's to
   * drop.
   */
  const placeholder = blurPlaceholderSource(described?.blurDataUrl)
  if (placeholder) {
    node.properties.style = appendDeclaration(
      node.properties.style,
      `${BLUR_PROPERTY}:${placeholder}`,
    )
  }

  node.properties.className = [
    ...toClassList(node.properties.className),
    'md-image__img',
  ]
}

/**
 * Wrap images so the caption-less ones can be laid out and centred by CSS, and
 * offer the other formats the asset was stored in.
 *
 * ## Why the `<picture>` is inside the wrapper
 *
 * `<picture>` may contain `<source>` elements and one `<img>`, and nothing
 * else. A wrapper between it and the image would be invalid HTML, and a browser
 * repairs invalid HTML by guessing — so the wrapper goes outside and the
 * picture, when there is one, goes in.
 *
 * ## Why the image never depends on a variant
 *
 * The `<img>` is the stored original and stays exactly where the author put it;
 * the `<source>` elements are an offer the browser may decline. That is what
 * makes this safe for a format this project did not encode itself: a browser
 * that cannot read AVIF falls through to the next source, and one that reads
 * none of them falls through to the original. The alternative — rewriting the
 * `src` to a derivative — would replace a file that is known to be there with
 * one that is merely believed to be, and the failure mode of that is a broken
 * image rather than a heavier one.
 */
function wrapImages(
  images: { parent: Element; index: number; node: Element }[],
  described: ReadonlyMap<string, DocumentImage> | undefined,
): void {
  for (const image of images.reverse()) {
    const description = described?.get(imageSrc(image.node) ?? '')
    const content =
      description && description.sources.length > 0
        ? pictureFor(image.node, description)
        : image.node

    // `loading="lazy"` inside a `figure` with a caption reads better, but the
    // plain wrapper is enough for inline images.
    const wrapper: Element = {
      type: 'element',
      tagName: 'span',
      properties: { className: ['md-image'] },
      children: [content],
    }
    image.parent.children[image.index] = wrapper
  }
}

/** The `src` of an image node, or null when it has none. */
function imageSrc(node: Element): string | null {
  const src = node.properties.src
  return typeof src === 'string' ? src : null
}

/**
 * The image, with the formats it is also stored in offered beside it.
 *
 * The sources keep the order the caller supplied — see `DocumentImage` — and
 * `srcSet` is spelled the way hast spells it, which is the property the
 * serialiser turns back into `srcset`.
 */
function pictureFor(node: Element, described: DocumentImage): Element {
  return {
    type: 'element',
    tagName: 'picture',
    properties: {},
    children: [
      ...described.sources.map(
        (source): Element => ({
          type: 'element',
          tagName: 'source',
          properties: { type: source.type, srcSet: source.url },
          children: [],
        }),
      ),
      node,
    ],
  }
}

/* -------------------------------------------------------------------------- */
/*  Embeds                                                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toClassList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  return []
}

/**
 * Add one declaration to a `style` attribute, keeping whatever was in it.
 *
 * The separator is only inserted when the existing text does not already end in
 * one, so `color:red;` and `color:red` both become `color:red;<ours>` rather
 * than the empty declaration a doubled semicolon would leave behind. Text that
 * is not a string at all — a property list, which is what hast allows — is
 * treated as absent, because there is nothing here that could read it.
 */
function appendDeclaration(existing: unknown, declaration: string): string {
  const current = typeof existing === 'string' ? existing.trim() : ''
  if (!current) return declaration
  return current.endsWith(';') ? `${current}${declaration}` : `${current};${declaration}`
}

export type { ElementContent }
