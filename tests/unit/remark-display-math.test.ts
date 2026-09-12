import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '@/lib/markdown/renderer'

/**
 * One-line `$$…$$` read as display math.
 *
 * The rule exists because `micromark-extension-math` decides between inline and
 * display by *where* the opening fence sits, not by which delimiters were used:
 * anything after `$$` on the opening line is read as the fence's meta string,
 * so a one-line `$$a = b$$` never matches the flow construct and lands as
 * inline math. Authors write it on one line constantly.
 *
 * The negative cases matter more than the positive one. A rule that promoted
 * every paragraph containing an equation would pull prose apart, and one that
 * promoted single-dollar math would restyle documents nobody asked to change —
 * so both are pinned here rather than left to the reasoning.
 */

/** The class `rehype-katex` puts on a display equation's wrapper. */
const DISPLAY = 'katex-display'

describe('remarkDisplayMath', () => {
  it('promotes a paragraph that is exactly one $$-fenced equation', async () => {
    const { html } = await renderMarkdown('$$\n\\sum_{i=0}^{n} i\n$$\n', {})
    const { html: oneLine } = await renderMarkdown('$$\\sum_{i=0}^{n} i$$\n', {})

    expect(html).toContain(DISPLAY)
    expect(oneLine).toContain(DISPLAY)
  })

  it('renders the one-line form the same as the two-line form', async () => {
    const body = '\\frac{a}{b} = c'
    const { html: oneLine } = await renderMarkdown(`$$${body}$$\n`, {})
    const { html: twoLine } = await renderMarkdown(`$$\n${body}\n$$\n`, {})

    // Same markup, not merely the same class: the whole point of the rule is
    // that the two spellings are one document.
    expect(oneLine).toBe(twoLine)
  })

  it('leaves single-dollar math inline', async () => {
    const { html } = await renderMarkdown('$k_1 = 1.2$\n', {})

    expect(html).not.toContain(DISPLAY)
    expect(html).toContain('class="katex"')
  })

  it('leaves an equation with prose around it inline', async () => {
    const { html } = await renderMarkdown('The value $$a = b$$ is fixed.\n', {})

    expect(html).not.toContain(DISPLAY)
    expect(html).toContain('The value')
    expect(html).toContain('is fixed.')
  })

  it('leaves a paragraph of two equations alone', async () => {
    const { html } = await renderMarkdown('$$a$$ and $$b$$\n', {})

    expect(html).not.toContain(DISPLAY)
  })

  it('still promotes when the paragraph is one equation among others', async () => {
    const { html } = await renderMarkdown('$$a = b$$\n\n$$c = d$$\n', {})

    expect(html.match(new RegExp(DISPLAY, 'g'))).toHaveLength(2)
  })

  it('does not promote a paragraph of prose that happens to contain dollars', async () => {
    // Written expecting the two single dollars to stay literal. They do not:
    // micromark pairs them into one *inline* equation reading `5 and`. That is
    // its reading of the input and not this rule's business — what this rule
    // must not do is promote it, and the paragraph still has to be a paragraph:
    // the promotion is conditioned on the equation being the paragraph's only
    // child, which here it is not.
    const { html } = await renderMarkdown('The price is $5 and $6.\n', {})

    expect(html).not.toContain(DISPLAY)
    expect(html).toContain('The price is')
    expect(html).toContain('6.')
  })
})
