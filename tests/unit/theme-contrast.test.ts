import { describe, expect, it } from 'vitest'
import { bundledThemes } from 'shiki/themes'
import type { ThemeRegistration } from 'shiki'

import {
  composite,
  contrastRatio,
  contrastSafeHex,
  formatHex,
  luminance,
  makeContrastSafeTheme,
  parseHex,
  type Rgba,
} from '@/lib/markdown/theme-contrast'
import { SHIKI_THEMES, TOKENIZE_TIME_LIMIT, getThemes } from '@/lib/markdown/shiki'

/**
 * The syntax palettes, checked against WCAG AA.
 *
 * `tests/unit/contrast.test.ts` does this for the design tokens in
 * `globals.css`. This does it for the code blocks, which are painted from a
 * third-party theme with its own colours and its own idea of how faint a
 * comment may be — the reason fourteen of vitesse-light's twenty-nine
 * foregrounds had to be rewritten before the site could claim AA at all.
 *
 * The assertions are made against the *bundled* themes rather than against a
 * fixture, so bumping shiki and inheriting a palette that fails is a failing
 * test rather than a page nobody looks at.
 */

const CONTRAST_FLOOR = 4.5

const THEME_NAMES = Object.values(SHIKI_THEMES)

async function bundled(name: string): Promise<ThemeRegistration> {
  // Named `loaded` rather than `module`: `module` is reserved for the CommonJS
  // binding that Next's lint rules police, and it is not ours to shadow.
  const loaded = await bundledThemes[name as keyof typeof bundledThemes]()
  return loaded.default as ThemeRegistration
}

/** Every `(foreground, surface)` pair a theme can paint, as the reader sees it. */
function paintedPairs(theme: ThemeRegistration): { fg: Rgba; bg: Rgba; where: string }[] {
  const themeBackground = theme.colors?.['editor.background']
  if (!themeBackground) throw new Error(`${theme.name} declares no editor.background`)

  const pairs: { fg: Rgba; bg: Rgba; where: string }[] = []
  const push = (fg: string | undefined, bg: string, where: string) => {
    if (!fg) return
    const parsedFg = parseHex(fg)
    const parsedBg = parseHex(bg)
    if (!parsedFg || !parsedBg) throw new Error(`${where}: unreadable colour ${fg} on ${bg}`)
    pairs.push({ fg: parsedFg, bg: parsedBg, where })
  }

  push(theme.colors?.['editor.foreground'], themeBackground, 'editor.foreground')
  for (const token of theme.tokenColors ?? []) {
    // A scope is a string or a list of them; the first two are enough to name
    // the token in a failure message.
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope ?? 'no scope']
    push(
      token.settings?.foreground,
      token.settings?.background ?? themeBackground,
      scopes.slice(0, 2).join(' | '),
    )
  }
  return pairs
}

/** The ratio a reader experiences, with any translucency resolved. */
function paintedRatio({ fg, bg }: { fg: Rgba; bg: Rgba }): number {
  const painted = fg[3] < 1 ? composite(fg, bg) : fg
  return contrastRatio(painted, bg)
}

describe('contrastSafeHex', () => {
  it('leaves a colour alone when it already passes', () => {
    expect(contrastSafeHex('#1e754f', '#ffffff')).toBe('#1e754f')
  })

  it('leaves a colour alone when it cannot be parsed', () => {
    // Not a failure: a theme is third-party data, and a token foreground is not
    // a place to throw inside a render.
    expect(contrastSafeHex('rebeccapurple', '#ffffff')).toBe('rebeccapurple')
    expect(contrastSafeHex('#12345', '#ffffff')).toBe('#12345')
  })

  it('moves a failing colour away from its background, keeping the hue', () => {
    const fixed = contrastSafeHex('#b07d48', '#ffffff')
    // Same warm brown, further from white. Asserted as an ordering rather than
    // a literal so the test states the property and not one rounding.
    expect(contrastRatio(parseHex(fixed)!, parseHex('#ffffff')!)).toBeGreaterThanOrEqual(4.6)
    expect(formatHex(parseHex(fixed)!)).toBe(fixed)
  })

  it('darkens against a light background and lightens against a dark one', () => {
    // One colour from each palette's real failures — `#b07d48` is the light
    // theme's variable brown, `#666666` the dark theme's delimiter grey. Each
    // fails on its own background and passes on the other, which is the point:
    // the direction has to be read from the background, not from the colour.
    const onWhite = parseHex(contrastSafeHex('#b07d48', '#ffffff'))!
    const onBlack = parseHex(contrastSafeHex('#666666', '#121212'))!

    expect(luminance(onWhite)).toBeLessThan(luminance(parseHex('#b07d48')!))
    expect(luminance(onBlack)).toBeGreaterThan(luminance(parseHex('#666666')!))
  })

  it('raises alpha to 1, because 47% on white cannot reach the floor', () => {
    // The unreachable case: at 47% alpha the darkest possible composite over
    // white is pure black, which is 3.6:1. No base colour can satisfy AA, so
    // the fix has to change the opacity and not only the colour.
    const impossible = composite([0, 0, 0, 0.47], parseHex('#ffffff')!)
    expect(contrastRatio(impossible, parseHex('#ffffff')!)).toBeLessThan(CONTRAST_FLOOR)

    const fixed = parseHex(contrastSafeHex('#b5695977', '#ffffff'))!
    expect(fixed[3]).toBe(1)
    expect(contrastRatio(fixed, parseHex('#ffffff')!)).toBeGreaterThanOrEqual(CONTRAST_FLOOR)
  })

  it('keeps the alpha of a translucent colour that already passes', () => {
    // 93% near-white on near-black is legible as it stands, and the slight
    // translucency is part of how the theme reads.
    expect(contrastSafeHex('#dbd7caee', '#121212')).toBe('#dbd7caee')
  })

  it('handles the short hex forms', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255, 1])
    expect(parseHex('#0000')).toEqual([0, 0, 0, 0])
    expect(formatHex([255, 0, 0, 1])).toBe('#ff0000')
  })

  it('round-trips every colour through parse and format', () => {
    for (const value of ['#000000', '#ffffff', '#b07d48', '#b5695977', '#0a0b0c']) {
      expect(formatHex(parseHex(value)!)).toBe(value)
    }
  })
})

describe('makeContrastSafeTheme', () => {
  it.each(THEME_NAMES)('%s keeps its identity', async (name) => {
    const theme = await bundled(name)
    const safe = makeContrastSafeTheme(theme)

    expect(safe.name).toBe(theme.name)
    expect(safe.type).toBe(theme.type)
    expect(safe.tokenColors).toHaveLength(theme.tokenColors?.length ?? 0)
  })

  it.each(THEME_NAMES)('%s leaves backgrounds and styling alone', async (name) => {
    const theme = await bundled(name)
    const safe = makeContrastSafeTheme(theme)

    // Only foregrounds may move. A changed background would change what the
    // reader's eye is doing with the whole block, and a changed fontStyle would
    // change what the code says.
    expect(safe.colors?.['editor.background']).toBe(theme.colors?.['editor.background'])
    for (const [index, token] of (theme.tokenColors ?? []).entries()) {
      expect(safe.tokenColors?.[index]?.settings?.background).toBe(token.settings?.background)
      expect(safe.tokenColors?.[index]?.settings?.fontStyle).toBe(token.settings?.fontStyle)
      expect(safe.tokenColors?.[index]?.scope).toEqual(token.scope)
    }
  })

  it.each(THEME_NAMES)('%s reads at AA on every surface it paints', async (name) => {
    const theme = await bundled(name)
    const safe = makeContrastSafeTheme(theme)

    const failures = paintedPairs(safe)
      .map((pair) => ({ ...pair, ratio: paintedRatio(pair) }))
      .filter((pair) => pair.ratio < CONTRAST_FLOOR)

    expect(
      failures.map((f) => `${f.where}: ${formatHex(f.fg)} on ${formatHex(f.bg)} = ${f.ratio.toFixed(2)}`),
    ).toEqual([])
  })

  it.each(THEME_NAMES)('%s was actually broken before the rewrite', async (name) => {
    // Guards the test itself: if a future shiki ships a compliant palette, the
    // assertion above would still pass but would no longer be testing anything,
    // and this one failing is how that gets noticed.
    const theme = await bundled(name)
    const failing = paintedPairs(theme).filter((pair) => paintedRatio(pair) < CONTRAST_FLOOR)

    expect(failing.length).toBeGreaterThan(0)
  })

  it('returns the theme untouched when it declares no background', () => {
    const theme: ThemeRegistration = {
      name: 'no-background',
      type: 'light',
      tokenColors: [{ scope: 'comment', settings: { foreground: '#eeeeee' } }],
    }

    expect(makeContrastSafeTheme(theme)).toBe(theme)
  })
})

describe('the highlighter’s themes', () => {
  it('are the rewritten pair, not the bundled originals', async () => {
    const themes = await getThemes()

    for (const [key, theme] of Object.entries(themes)) {
      expect(theme.name).toBe(SHIKI_THEMES[key as keyof typeof SHIKI_THEMES])

      const failures = paintedPairs(theme).filter((pair) => paintedRatio(pair) < CONTRAST_FLOOR)
      expect(failures).toEqual([])
    }
  })

  it('arrive as a copy, so that building a highlighter cannot rewrite the cache', async () => {
    /*
     * Shiki normalises a theme in place — `createHighlighter` rewrites the
     * `tokenColors` of the object it is handed. Every caller here hands it the
     * pair from `getThemes()`, so if that pair were the cached objects
     * themselves, a highlighter would be editing what the next reader gets.
     *
     * The assertion is on the *serialised* palette, because that is what shiki
     * changes — an in-place rewrite keeps the object identity, so only the
     * contents can tell the two apart. `getThemes` records what was measured.
     */
    const before = JSON.stringify((await getThemes()).light.tokenColors)

    const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki')
    const handed = await getThemes()
    await createHighlighter({
      themes: [handed.light],
      langs: ['typescript'],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })

    expect(JSON.stringify((await getThemes()).light.tokenColors)).toBe(before)
  })

  it('still emit both palettes as CSS variables', async () => {
    // The whole theming strategy is that shiki writes `--shiki-light` and
    // `--shiki-dark` and the stylesheet picks between them. Passing theme
    // *objects* instead of names is what makes this worth asserting: if shiki
    // ever keyed those variables off something else, every code block on the
    // site would silently lose one of its two palettes.
    //
    // The budget is the app's, not shiki's default, so that this renders under
    // the settings production renders under — see `TOKENIZE_TIME_LIMIT`. With
    // the default, this assertion failed at random once in every few runs on a
    // loaded machine, because the tokenisation of one of the two palettes was
    // being cut off mid-line and the other one's colours filled in.
    const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki')
    const themes = await getThemes()

    const highlighter = await createHighlighter({
      themes: [themes.light, themes.dark],
      langs: ['typescript'],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })

    const hast = highlighter.codeToHast('const answer = 42 // the point\n', {
      lang: 'typescript',
      themes,
      defaultColor: false,
      tokenizeTimeLimit: TOKENIZE_TIME_LIMIT,
    })

    // Shiki writes the style attribute in uppercase hex, so the comparison is
    // case-folded rather than the expected value being spelled twice.
    const html = JSON.stringify(hast).toLowerCase()
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
    expect(html).toContain('--shiki-light-bg:#ffffff')
    expect(html).toContain('--shiki-dark-bg:#121212')

    // The comment is the token that failed hardest, so it is the one to check
    // came through rewritten.
    expect(html).toContain(contrastSafeHex('#a0ada0', '#ffffff'))
  })
})

describe('the code render path', () => {
  it('gives tokenisation a budget a cold process can afford', () => {
    /*
     * The failure this guards against is not "highlighting is slow" but
     * "highlighting is wrong": when shiki's time limit runs out it stops
     * mid-line and hands back the tokens it has, so a truncated line reaches
     * the dual-theme merge as a single token and its first colour is spread
     * over the rest. The first tokenisation in a process — the one that
     * compiles the grammars — was measured at 216 ms idle and up to 638 ms
     * with the suite running, against a 500 ms default. The 638 ms run is the
     * one the palette assertion above failed in.
     *
     * Asserted as a floor rather than as the literal, because the property
     * worth failing on is "far enough above the cold cost that the race is not
     * close", not one particular number. `TOKENIZE_TIME_LIMIT` carries the
     * measurements and the reasoning for the value it holds.
     */
    expect(TOKENIZE_TIME_LIMIT).toBeGreaterThanOrEqual(5_000)
  })
})
