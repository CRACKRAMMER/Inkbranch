import { defaultSchema } from 'rehype-sanitize'
import type { Options as SanitizeSchema } from 'rehype-sanitize'

/**
 * HTML sanitisation allow-list.
 *
 * Runs last, on the final tree, immediately before serialisation. Rendered
 * Markdown reaches the page through `dangerouslySetInnerHTML`, so this is the
 * boundary that makes raw HTML in an article safe — it is not optional
 * hardening, it is the control.
 *
 * The schema starts from `hast-util-sanitize`'s default (which already handles
 * protocol filtering, `on*` attribute stripping and the class of tricks that
 * make naive allow-lists fail) and adds exactly what this site's Markdown
 * pipeline emits.
 */

/**
 * Attributes that may appear on any allowed element.
 *
 * Names are written in hast's camelCase property form. `hast-util-sanitize`
 * compares schema entries to property keys with `===`, and it keeps the key it
 * was given — so a schema listing `'aria-label'` would not match a property
 * stored as `ariaLabel`. Everything that reaches this point has already been
 * through `rehype-raw`, which re-parses through `property-information` and
 * normalises `aria-*` and `data-*` to that camelCase form.
 */
const GLOBAL_ATTRIBUTES = [
  'className',
  'id',
  // Accessibility wiring: hand-written markup still needs this.
  'role',
  'tabIndex',
  'ariaLabel',
  'ariaHidden',
  'ariaSelected',
  'ariaControls',
  'ariaExpanded',
  'ariaLabelledBy',
  'ariaDescribedBy',
  'ariaLive',
  'ariaCurrent',
  // `data*` is a special value in the schema language: it matches every
  // property whose name begins with `data`, which covers all the hooks the
  // plugins emit (`dataLine`, `dataHeading`, `dataMermaid`, …) without
  // enumerating them here and again every time a plugin is added.
  'data*',
  // `:::columns` sets a custom property through `style`, and Shiki's own
  // output relies on it too. Only the site owner writes Markdown here.
  'style',
]

/** Elements this pipeline produces or permits. */
const TAG_NAMES = [
  ...(defaultSchema.tagNames ?? []),
  // GitHub-flavoured Markdown
  'details',
  'summary',
  'kbd',
  'mark',
  'figure',
  'figcaption',
  'aside',
  'section',
  'span',
  'abbr',
  'sup',
  'sub',
  // The `:::tabs` toolbar. Without this the sanitiser *unwraps* each button —
  // the elements disappear and their label text is spliced into the tablist as
  // bare text, which looks almost right and is entirely broken.
  'button',
  'video',
  'audio',
  'source',
  'iframe',
  'svg',
  'path',
  'rect',
  'circle',
  'line',
  'polyline',
  'polygon',
  'g',
  'use',
  'defs',
  'symbol',
  'title',
  'desc',
]

/**
 * Note on `clobberPrefix`: the default schema prefixes `id`/`name` values with
 * `user-content-` to defeat DOM clobbering. That would break every heading
 * anchor, since the table of contents is generated from the unprefixed slug.
 * The prefix is therefore disabled, and the `name` attribute — the vector that
 * actually enables clobbering form and iframe elements — is not allowed on any
 * tag below. `id` remains, which an author could use to shadow a global, but
 * only the site owner can write Markdown here, and they already control the
 * whole origin. That trade-off is deliberate.
 */
export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  tagNames: TAG_NAMES,

  attributes: {
    ...defaultSchema.attributes,

    // A per-tag list is *additional* to `'*'`, never a restriction on it: the
    // sanitiser falls back to the `'*'` list when the tag-specific list has no
    // entry for a property. `className` and `style` therefore appear only in
    // the global list, not repeated on every tag.
    '*': [...(defaultSchema.attributes?.['*'] ?? []), ...GLOBAL_ATTRIBUTES],

    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],

    // Tab buttons are inert without JavaScript: nothing in the document wires
    // a handler, and `type` is pinned to `button` so an element in an article
    // can never act as a submit button for a form on the same page.
    button: [['type', 'button'], 'disabled'],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      'loading',
      'decoding',
      'width',
      'height',
      'srcSet',
      'sizes',
    ],

    // Task list checkboxes stay presentational: `disabled` is forced so a
    // rendered document can never submit anything.
    input: [['type', 'checkbox'], 'checked', 'disabled'],

    abbr: [...(defaultSchema.attributes?.abbr ?? []), 'title'],
    details: ['open'],

    video: [
      'src', 'poster', 'controls', 'preload', 'loop', 'muted',
      'playsInline', 'width', 'height',
    ],
    audio: ['src', 'controls', 'preload', 'loop'],
    source: ['src', 'srcSet', 'type', 'media'],
    iframe: [
      'src', 'title', 'width', 'height', 'allow', 'allowFullScreen',
      'referrerPolicy', 'loading',
    ],

    // Inline SVG is emitted only by our own code-block header. The default
    // schema strips `svg` entirely, so these are declared explicitly and kept
    // to geometry attributes — no `href`, no event handlers, no `use` targets.
    svg: [
      'viewBox', 'width', 'height', 'fill', 'stroke', 'strokeWidth',
      'strokeLinecap', 'strokeLinejoin', 'xmlns',
    ],
    path: ['d', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth'],
    polyline: ['points', 'fill', 'stroke'],
    polygon: ['points', 'fill', 'stroke'],
    g: ['fill', 'stroke', 'transform'],
  },

  // Sanitising a fragment makes anything outside the allow-list vanish, so
  // `script`, `style`, `iframe` from user HTML and event handlers disappear
  // without a separate pass.
  strip: ['script', 'style'],
}

/**
 * Origins permitted in an `<iframe>`.
 *
 * Kept as an explicit list rather than "any https host": an embed is a hole
 * through the page's CSP and privacy, so each one is a decision.
 */
export const ALLOWED_EMBED_ORIGINS = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'player.vimeo.com',
  'www.bilibili.com',
  'player.bilibili.com',
  'codesandbox.io',
  'stackblitz.com',
  'observablehq.com',
  'www.desmos.com',
] as const

/** Origins allowed in `<video>`/`<audio>` sources. */
export const ALLOWED_MEDIA_ORIGINS = ['cdn.jsdelivr.net'] as const
