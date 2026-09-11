import type { ElementContent } from 'hast'
import type { Literal } from 'mdast'
import type { Handlers, State } from 'mdast-util-to-hast'

/**
 * mdast → hast handlers that `mdast-util-to-hast` does not ship.
 *
 * Only math needs one. `remark-math` registers micromark and (de)serialisation
 * extensions and nothing else — it has no to-hast handler — so without these an
 * `inlineMath` node reaches the library's unknown-node fallback and renders as
 * literal TeX. `rehype-katex` then looks for an element carrying `math-inline`
 * or `math-display`, so the whole job here is to produce that element with the
 * raw source as its text.
 *
 * Definition lists are *not* here: `remark-deflist` sets `data.hName` on the
 * nodes it creates, and the same fallback honours `hName`.
 */

/** `inlineMath` and `math` both carry their source in `value`. */
type MathLiteral = Literal & { type: 'inlineMath' | 'math' }

/**
 * The first parameter is the shared conversion state, which these handlers do
 * not need but `Handler` requires. The second is narrowed from the `any` that
 * the handler table declares: `any` is assignable in both directions, so a
 * concrete node type here costs nothing and keeps the body honest without an
 * assertion at the call site.
 */
function mathElement(display: boolean) {
  return (_state: State, node: MathLiteral): ElementContent => ({
    type: 'element',
    tagName: display ? 'div' : 'span',
    properties: { className: [display ? 'math-display' : 'math-inline'] },
    children: [{ type: 'text', value: node.value }],
  })
}

export const mdastHandlers: Handlers = {
  math: mathElement(true),
  inlineMath: mathElement(false),
}
