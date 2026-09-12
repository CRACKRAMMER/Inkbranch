import type { Paragraph, Root, RootContent } from 'mdast'
import { visit } from 'unist-util-visit'

/**
 * The one thing this needs from the file unified hands a transformer.
 *
 * Declared here rather than imported from `vfile`, which is a transitive
 * dependency of the pipeline and not one of ours — and which this plugin does
 * not otherwise care about. A parameter type is not a reason to take on a
 * package.
 */
interface SourceFile {
  value: unknown
}

/**
 * Read `$$…$$` written on one line as display math.
 *
 * ## The problem
 *
 * `micromark-extension-math` — what `remark-math` is a thin wrapper over — has
 * two constructs, and they are not chosen by the delimiters alone. A flow (an
 * equation on its own line, which KaTeX renders as a display block) only starts
 * when the opening `$$` is the *last* thing on its line: the tokenizer takes
 * everything after the fence on that line as the fence's **meta** string, the
 * way a code fence takes `js title="x"`. So
 *
 *     $$
 *     a = b
 *     $$
 *
 * is display math, and `$$a = b$$` on one line is not — the flow construct
 * finds no closing fence and never matches, the line becomes an ordinary
 * paragraph, and the inline construct picks the dollars up on the way past.
 * The result is a formula the author marked as a display equation rendering
 * inline: smaller, centred in the middle of a sentence, with the paragraph
 * baseline dragged around it.
 *
 * That is the documented behaviour of the library, and it is the wrong
 * behaviour for this site. `$$…$$` on one line is what the form means nearly
 * everywhere an author might have written it first — Obsidian, Jupyter,
 * GitHub's own math support, KaTeX's auto-render — and the rule the site
 * enforces instead would be one nobody can see: two documents that look
 * identical in the editor render differently, and the difference is an invisible
 * newline. Markdown is this project's source of truth and its articles arrive
 * as files that have already been written; the pipeline's job is to read what
 * they say.
 *
 * ## The rule
 *
 * A paragraph whose entire content is one `inlineMath` node, whose source
 * begins and ends with `$$`, becomes a `math` node. Both halves are load-bearing:
 *
 *   - **the whole paragraph**, because `$$x$$ and then some prose` is a
 *     sentence with an equation in it, and promoting that would pull the words
 *     apart. Only a paragraph that is *nothing but* the equation is ambiguous,
 *     and only an ambiguous one is touched.
 *   - **the `$$` delimiters**, read back off the source rather than assumed,
 *     because a paragraph that is exactly `$x$` is a paragraph that is exactly
 *     `$x$`. Single dollars mean inline, the author typed them deliberately, and
 *     guessing otherwise would silently restyle existing documents.
 *
 * The node keeps its position and its value, so nothing downstream — the
 * heading slugs, the feature flags, the error message KaTeX prints for a
 * malformed expression — sees a difference between this and the two-line form.
 * It runs before `remarkRehype`, which is where `mdastHandlers` turns it into
 * the `math-display` element `rehype-katex` is looking for.
 */
export function remarkDisplayMath() {
  return (tree: Root, file: SourceFile): void => {
    const source = String(file.value)

    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (index === undefined || !parent) return
      if (node.children.length !== 1) return

      const child = node.children[0]
      if (!child || child.type !== 'inlineMath') return

      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (start === undefined || end === undefined) return

      const written = source.slice(start, end)
      if (!written.startsWith('$$') || !written.endsWith('$$') || written.length < 5) return

      const promoted: RootContent = {
        type: 'math',
        value: child.value,
        position: child.position,
      }
      parent.children[index] = promoted
    })
  }
}
