import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The colour tokens, checked against WCAG AA.
 *
 * ## Why this reads the stylesheet instead of importing something
 *
 * The tokens are CSS custom properties in `globals.css` and nothing else knows
 * their values — that is the point of them. A checker that imported a
 * TypeScript copy would be asserting that the copy agrees with itself; the
 * browser is the only thing that reads the real ones, and it is not available
 * here. So the file is parsed, which has the useful side effect that the test
 * fails the moment a token is changed rather than the moment someone remembers
 * to update a second definition.
 *
 * ## Why oklch is converted by hand
 *
 * There is no way to ask a CSS engine for a computed colour in this suite, and
 * the conversion is a published formula rather than a decision — the same is
 * true of the contrast ratio. Both are written out below. The risk a copy
 * normally carries — drifting from the original — does not apply: the
 * original is the WCAG specification, and it is not going to be edited.
 *
 * ## What is checked, and what is not
 *
 * Text colours against each of the three backgrounds they are used on, and the
 * three foreground-on-fill pairs a button or badge can produce. 4.5:1 is the
 * AA floor for normal-size text, and it is the floor here for every token
 * because every one of them is used at body size somewhere — a colour that
 * only ever appeared in 24px headings could be held to 3:1, and none of these
 * is. Borders, rules and the quiet fills are deliberately out of scope: they
 * are not text, and their contrast requirement is a different one that this
 * test would only pretend to be checking.
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
  'utf8',
)

/** A token block: `--color-x: oklch(…)` lines between the braces of `header`. */
function blockFor(selector: RegExp): Map<string, [number, number, number]> {
  const start = css.search(selector)
  if (start === -1) throw new Error(`no block matching ${selector} in globals.css`)

  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  if (open === -1 || close === -1) throw new Error(`unterminated block for ${selector}`)

  const tokens = new Map<string, [number, number, number]>()
  const pattern = /--color-([a-z-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g

  for (const match of css.slice(open, close).matchAll(pattern)) {
    const [, name, l, c, h] = match
    if (!name || l === undefined || c === undefined || h === undefined) continue
    tokens.set(name, [Number(l) / 100, Number(c), Number(h)])
  }

  return tokens
}

const light = blockFor(/^@theme \{/m)
const dark = blockFor(/^\.dark \{/m)

/** oklch → linear-light sRGB, per Björn Ottosson's OKLab matrices. */
function toRgb([L, C, H]: [number, number, number]): [number, number, number] {
  const radians = (H * Math.PI) / 180
  const a = C * Math.cos(radians)
  const b = C * Math.sin(radians)

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3

  const encode = (value: number) =>
    value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055

  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ].map((channel) => Math.min(1, Math.max(0, channel))) as [number, number, number]
}

/** WCAG 2.1 relative luminance. */
function luminance(token: [number, number, number]): number {
  const [r, g, b] = toRgb(token)
  const channel = (value: number) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** The sRGB of a token, for reporting a failure in the colour that was painted. */
function toHex(token: [number, number, number]): string {
  return (
    '#' +
    toRgb(token)
      .map((channel) =>
        Math.round(Math.min(1, Math.max(0, channel)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

/**
 * `color-mix(in oklch, tone p%, base)`, per CSS Color 5.
 *
 * Both operands are opaque, so there is no premultiplication and the mix is a
 * straight interpolation of lightness, chroma and hue. The hue takes the
 * shorter arc — except where it is *powerless*.
 *
 * That exception is the whole reason this function is written out rather than
 * approximated. The light surface is `oklch(100% 0 0)`; at zero chroma a hue
 * says nothing about the colour, so CSS treats it as missing and the mix keeps
 * the tone's own hue. Interpolating towards the meaningless zero instead lands
 * the tint at hue 3.5° — a pink wash — where the browser paints hue 72°, a
 * cream. The ratio moves by barely a hundredth and the test still catches what
 * it is for, but it would then be measuring a colour the design does not
 * contain, and reporting it in the failure message as if it were real.
 */
function mixOklch(
  tone: [number, number, number],
  base: [number, number, number],
  percent: number,
): [number, number, number] {
  const [toneL, toneC, toneH] = tone
  const [baseL, baseC, baseH] = base

  const share = 1 - percent

  const hue = (() => {
    if (toneC === 0) return baseH
    if (baseC === 0) return toneH

    let delta = baseH - toneH
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360
    return (toneH + delta * share + 360) % 360
  })()

  return [toneL * percent + baseL * share, toneC * percent + baseC * share, hue]
}

function contrast(foreground: string, background: string, theme: Map<string, [number, number, number]>): number {
  const fg = theme.get(foreground)
  const bg = theme.get(background)
  if (!fg || !bg) throw new Error(`missing token: ${!fg ? foreground : background}`)

  const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return ((lighter as number) + 0.05) / ((darker as number) + 0.05)
}

/** Every background a token can be set on. All three are used across the site. */
const BACKGROUNDS = ['canvas', 'surface', 'sunken'] as const

/** Text colours: the body greys, the accent, and the four status colours. */
const TEXT_TOKENS = [
  'ink',
  'ink-muted',
  'ink-subtle',
  'brand',
  'success',
  'warning',
  'danger',
  'info',
] as const

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast', (name, theme) => {
  it('defines every token it is asked about', () => {
    // A rename would otherwise turn every assertion below into a thrown error
    // about a missing token rather than a statement about colour.
    for (const token of [...TEXT_TOKENS, ...BACKGROUNDS]) {
      expect(theme.has(token), `${name} token --color-${token}`).toBe(true)
    }
  })

  it.each(TEXT_TOKENS)('--color-%s clears 4.5:1 on every background', (token) => {
    for (const background of BACKGROUNDS) {
      const ratio = contrast(token, background, theme)
      expect(
        Number(ratio.toFixed(2)),
        `${name}: --color-${token} on --color-${background} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([
    ['primary-foreground on primary', 'canvas', 'ink'],
    ['brand-foreground on brand', 'brand-foreground', 'brand'],
    ['brand-foreground on danger', 'brand-foreground', 'danger'],
  ])('reads %s', (_label, foreground, background) => {
    const ratio = contrast(foreground, background, theme)
    expect(
      Number(ratio.toFixed(2)),
      `${name}: --color-${foreground} on --color-${background} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * The tinted callout backgrounds, read out of the stylesheet.
 *
 * A callout title is painted in its tone colour on a surface tinted *with* that
 * same tone, which is the one background in the design that pulls the two ends
 * of the ratio towards each other. It is also the one that was missed: every
 * tone cleared 4.5:1 on canvas, surface and sunken, and the light warning still
 * came out at 4.45:1 on its own 8% tint. So the tint is modelled here and the
 * percentage is read from the rule rather than restated, because the rule is
 * what the browser applies.
 */
function tintedTones(): { tone: string; base: string; percent: number }[] {
  const pattern =
    /\.md-callout--([a-z]+)\s*\{\s*background-color:\s*color-mix\(in oklch,\s*var\(--color-([a-z-]+)\)\s*([\d.]+)%,\s*var\(--color-([a-z-]+)\)\)/g

  const found = [...css.matchAll(pattern)].map((match) => ({
    tone: match[2] as string,
    base: match[4] as string,
    percent: Number(match[3]) / 100,
  }))

  if (found.length !== 4) {
    throw new Error(`expected four tinted callouts in globals.css, found ${found.length}`)
  }
  return found
}

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('the %s callout titles', (name, theme) => {
  it.each(tintedTones().map((entry) => [entry.tone, entry] as const))(
    '--color-%s reads on its own tint',
    (token, entry) => {
      const tone = theme.get(token)
      const base = theme.get(entry.base)
      if (!tone || !base) throw new Error(`missing token: ${token} or ${entry.base}`)

      const tint = mixOklch(tone, base, entry.percent)
      const [lighter, darker] = [luminance(tone), luminance(tint)].sort((a, b) => b - a)
      const ratio = ((lighter as number) + 0.05) / ((darker as number) + 0.05)

      expect(
        Number(ratio.toFixed(2)),
        `${name}: --color-${token} (${toHex(tone)}) on its ${entry.percent * 100}% tint (${toHex(tint)}) is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)
    },
  )
})

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('the %s ink scale', (_name, theme) => {
  /*
   * Three weights of the same grey, in the order the design reads them: title,
   * body, then the asides and metadata. Raising a text token to clear the floor
   * is exactly the change that can flatten that order, so it is asserted rather
   * than assumed — a fix for contrast that costs the hierarchy is a different
   * bug, not a fix.
   */
  it('keeps ink, muted and subtle in descending contrast', () => {
    const ink = contrast('ink', 'canvas', theme)
    const muted = contrast('ink-muted', 'canvas', theme)
    const subtle = contrast('ink-subtle', 'canvas', theme)

    expect(ink).toBeGreaterThan(muted)
    expect(muted).toBeGreaterThan(subtle)
  })
})
