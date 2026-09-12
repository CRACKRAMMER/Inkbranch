import type { Root } from 'hast'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkDeflist from 'remark-deflist'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { mdastHandlers } from './handlers'
import { rehypeCaptureCodeMeta, rehypeCode } from './rehype-code'
import { rehypeEnhance, type DocumentImage } from './rehype-enhance'
import { remarkAlerts } from './remark-alerts'
import { remarkBlocks } from './remark-blocks'
import { ALLOWED_EMBED_ORIGINS, sanitizeSchema } from './sanitize-schema'

/**
 * Markdown → HTML.
 *
 * ## Order matters, in two places
 *
 * 1. **Sanitisation runs before the trusted transformers.** `rehype-sanitize`
 *    sees the tree that raw HTML from the source produced, and everything after
 *    it (`rehypeEnhance`, `rehypeCode`, `rehypeKatex`) emits markup this project
 *    generated. Sanitising last would mean either stripping KaTeX's `<span
 *    style>` output and Shiki's inline theme variables, or widening the
 *    allow-list until it no longer protects anything.
 *
 * 2. **`rehype-raw` runs immediately after the mdast→hast conversion**, because
 *    that is the only point at which raw HTML from the source exists as `raw`
 *    nodes. After it, the tree is ordinary hast and every later plugin can walk
 *    it normally.
 *
 * ## Element hints
 *
 * Directives, callouts and alerts declare `data.hName` / `data.hProperties` in
 * `remarkBlocks` and `remarkAlerts` rather than splicing HTML strings into the
 * tree. That is what lets the sanitiser see — and therefore police — the
 * elements those plugins produce.
 */

/** Content features present in a rendered document. */
export interface RenderFeatures {
  /** At least one syntax-highlighted code block. */
  code: boolean
  /** At least one Mermaid diagram placeholder. */
  mermaid: boolean
  /** At least one KaTeX expression. */
  math: boolean
  /** At least one `:::tabs` group, so the client controller is needed. */
  tabs: boolean
  /** At least one footnote section. */
  footnotes: boolean
  /** At least one allowed `<iframe>` embed. */
  embeds: boolean
}

export interface RenderOptions {
  /**
   * `"<type>/<slug>"` keys that exist in the content index.
   *
   * When supplied, internal links pointing at anything else are marked
   * `md-link--broken` and tagged with the missing target. Omit it and no link
   * is flagged — an empty set is not the same thing.
   */
  knownSlugs?: ReadonlySet<string>
  /**
   * What is known about the site's own images, keyed by `src` as written.
   *
   * This is the one option that comes from the database rather than from the
   * document, and it is an option rather than a lookup for exactly that reason:
   * rendering stays a pure function of its input, the loader lives in
   * `@/lib/content/render`, and a caller that has no database — a unit test, a
   * Markdown file being previewed off disk — can still render.
   */
  images?: ReadonlyMap<string, DocumentImage>
}

export interface RenderResult {
  /** Serialised HTML, intended for `dangerouslySetInnerHTML`. */
  html: string
  features: RenderFeatures
}

/**
 * Render a Markdown document to HTML.
 *
 * Safe to call concurrently: the processor is constructed per call. The
 * expensive part (syntax highlighting) is shared through the Shiki singleton in
 * `./shiki`, so building the pipeline each time costs microseconds.
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  let features: RenderFeatures | null = null

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDeflist)
    .use(remarkMath)
    .use(remarkDirective)
    .use(remarkBlocks)
    .use(remarkAlerts)
    .use(remarkRehype, {
      allowDangerousHtml: true,
      handlers: mdastHandlers,
      footnoteLabel: 'Footnotes',
      footnoteBackLabel: 'Back to content',
    })
    // Must come before `rehypeRaw`: it moves the code-fence meta off the node's
    // `data` field, which the parse5 round trip cannot carry.
    .use(rehypeCaptureCodeMeta)
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeEnhance, {
      allowedEmbedOrigins: ALLOWED_EMBED_ORIGINS,
      ...(options.knownSlugs ? { knownSlugs: options.knownSlugs } : {}),
      ...(options.images ? { images: options.images } : {}),
    })
    .use(rehypeCode)
    .use(rehypeKatex, {
      // A malformed expression must not take the page down. KaTeX renders the
      // source in an error colour instead, which is the useful failure mode in
      // the editor preview and in production alike.
      throwOnError: false,
      // Non-fatal warnings (`\text` in a Unicode engine, unicode text in TeX
      // mode) would otherwise be logged for every such expression on every
      // render. They are authoring nits, not site errors.
      strict: false,
    })
    // Must be the last transformer: everything upstream is a preparation for
    // the HTML that is actually served.
    .use(() => (tree: Root) => {
      features = collectFeatures(tree)
    })
    .use(rehypeStringify)

  const file = await processor.process(markdown)

  // The collector above always runs during `process`, so this is a typing
  // formality rather than a real possibility.
  if (!features) {
    throw new Error('Markdown pipeline finished without inspecting the tree')
  }

  return { html: String(file), features }
}

/* -------------------------------------------------------------------------- */
/*  Feature detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Report which optional features a document uses.
 *
 * Done by walking the finished tree rather than by scanning the Markdown
 * source. Source scanning gets the easy cases wrong in both directions — `$`
 * inside a code block is not math, and `mermaid` inside prose is not a diagram
 * — and the tree already knows.
 */
function collectFeatures(tree: Root): RenderFeatures {
  const features: RenderFeatures = {
    code: false,
    mermaid: false,
    math: false,
    tabs: false,
    footnotes: false,
    embeds: false,
  }

  visit(tree, 'element', (node) => {
    switch (node.tagName) {
      case 'figure':
        if (hasClass(node.properties.className, 'code-block')) features.code = true
        break

      case 'div':
        if (node.properties.dataMermaid !== undefined) features.mermaid = true
        if (hasClass(node.properties.className, 'md-tabs')) features.tabs = true
        // `rehype-katex` leaves `.katex` behind; the `math-*` classes only
        // survive if KaTeX declined to touch the node at all.
        if (hasClass(node.properties.className, 'math-display')) features.math = true
        break

      case 'span':
        if (
          hasClass(node.properties.className, 'katex') ||
          hasClass(node.properties.className, 'math-inline')
        ) {
          features.math = true
        }
        break

      case 'section':
        if (node.properties.dataFootnotes !== undefined) features.footnotes = true
        break

      case 'iframe':
        features.embeds = true
        break

      default:
        break
    }
  })

  return features
}

/**
 * `rehype-sanitize` keeps property keys exactly as it received them, so a class
 * list may arrive as an array (from mdast) or as a space-separated string (from
 * raw HTML that went through parse5). Both are checked.
 */
function hasClass(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entry === name)
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).includes(name)
  }
  return false
}
