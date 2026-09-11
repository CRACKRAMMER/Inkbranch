import { toString as hastToString } from 'hast-util-to-string'
import type { Element, ElementContent, Root } from 'hast'
import { visit } from 'unist-util-visit'
import { isExternalWebHref } from '@/lib/utils/url'
import { HeadingSlugger } from './slugger'

/**
 * Structural enhancement pass.
 *
 * Runs before the highlighter and before sanitisation. Everything here is
 * additive: heading anchors, table scroll wrappers, link rel/target policy and
 * image loading hints. Nothing removes content.
 */

export interface EnhanceOptions {
  /** Origins permitted inside an `<iframe>`. Anything else is dropped. */
  allowedEmbedOrigins: readonly string[]
  /** When set, internal document links are checked against known slugs. */
  knownSlugs?: ReadonlySet<string>
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
          enhanceImage(node)
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
      if (isAllowedEmbed(iframe.node, options.allowedEmbedOrigins)) continue
      // Drop disallowed embeds entirely rather than rendering a dead frame.
      iframe.parent.children.splice(iframe.index, 1)
    }

    wrapImages(tree, images)

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
function enhanceImage(node: Element): void {
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

  node.properties.className = [
    ...toClassList(node.properties.className),
    'md-image__img',
  ]
}

/** Wrap images so the caption-less ones can be laid out and centred by CSS. */
function wrapImages(
  tree: Root,
  images: { parent: Element; index: number; node: Element }[],
): void {
  for (const image of images.reverse()) {
    // `loading="lazy"` inside a `figure` with a caption reads better, but the
    // plain wrapper is enough for inline images.
    const wrapper: Element = {
      type: 'element',
      tagName: 'span',
      properties: { className: ['md-image'] },
      children: [image.node],
    }
    image.parent.children[image.index] = wrapper
  }
}

/* -------------------------------------------------------------------------- */
/*  Embeds                                                                     */
/* -------------------------------------------------------------------------- */

function isAllowedEmbed(node: Element, allowedOrigins: readonly string[]): boolean {
  const src = typeof node.properties.src === 'string' ? node.properties.src : ''
  if (!src) return false

  let parsed: URL
  try {
    parsed = new URL(src)
  } catch {
    // A relative embed is same-origin by definition, so it is allowed.
    return src.startsWith('/')
  }

  if (parsed.protocol !== 'https:') return false
  return allowedOrigins.some(
    (origin) => parsed.hostname === origin || parsed.hostname.endsWith(`.${origin}`),
  )
}

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

export type { ElementContent }
