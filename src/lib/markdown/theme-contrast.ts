/**
 * Make a syntax theme readable.
 *
 * ## The problem
 *
 * `vitesse-light` and `vitesse-dark` are editor themes. They are tuned for
 * someone already looking at the code, at a size where a faint comment still
 * resolves, and in an editor that is usually one pane among several. Moved to a
 * web page they fail WCAG AA outright: the light theme's comment grey is 2.34:1
 * against white and its delimiters 2.85:1, against the 4.5:1 every other text
 * colour on this site is held to. Fourteen of its twenty-nine foreground
 * colours are under the floor, across twenty-one of its token entries. That is
 * not a rounding error to be waved through — a comment a reader cannot read is
 * a comment the theme deleted.
 *
 * Shiki will not do this for us. 4.4.3 has no `colorReplacements` (compared
 * against the API the docs describe for 1.x), and a theme is an ordinary object,
 * so the fix is to rewrite the foregrounds before the highlighter sees them.
 *
 * ## What is rewritten, and what is not
 *
 * Only foregrounds, and only the ones that fail. A token's own background, the
 * theme's `editor.background`, the font styles and the scope lists are left
 * exactly as the theme author wrote them: this changes how legible the palette
 * is, not what the palette says.
 *
 * Each foreground is judged against the surface it is actually painted on — a
 * token that declares `settings.background` is measured against that, not
 * against the theme. This is not a detail. `carriage-return` is `#fafbfc`,
 * which reads as an invisible near-white and is in fact white text on a red
 * badge, at 4.42:1; judged against the theme background it would be "fixed"
 * into a mid grey, and the badge would become grey on red. The same reasoning
 * leaves `markup.ignored` alone in the dark theme, where its `#2f363d` is
 * legible on the blue it sits on and would have been lightened to nonsense.
 *
 * ## Why the alpha has to go
 *
 * Several tokens are translucent — `punctuation.definition.string` is `#b56959`
 * at 47% — which is how the theme de-emphasises them. On white, 47% alpha
 * cannot reach 4.5:1 at any base colour: pure black composites to 3.6:1, so the
 * floor is unreachable from below. A translucent colour that fails is therefore
 * made opaque. The two `#B56959` entries then land on the same value, which is
 * the honest outcome — the distinction the alpha drew is one AA does not permit,
 * and inventing a second colour to preserve it would be inventing a design the
 * theme never had.
 *
 * A translucent colour that already passes is left alone, alpha and all, so the
 * de-emphasis survives wherever it is affordable.
 *
 * ## Why it blends rather than converting to OKLCH
 *
 * A failing colour is moved towards black or towards white — whichever the
 * background is not — by the smallest factor that reaches the target. Scaling
 * all three channels by the same factor preserves the hue exactly, and the
 * contrast ratio is monotonic in that factor, so a bisection finds the boundary
 * directly. No colour-space conversion, and the result is a darker or lighter
 * version of the colour the author chose: `#b07d48` at 3.58:1 comes out
 * `#986c3e` at 4.62:1, the same warm brown, legible.
 *
 * (`tests/unit/contrast.test.ts` holds its own copy of the WCAG luminance
 * formula, written against oklch tokens read from the stylesheet. That copy is
 * not shared with this one because it has nothing in common with it beyond the
 * five lines of the specification itself — it converts oklch, this parses hex
 * and composites alpha — and the specification is not a thing that drifts.)
 */
import type { ThemeRegistration } from 'shiki'

/** sRGB with straight alpha, all four channels in 0..255 except alpha in 0..1. */
export type Rgba = readonly [number, number, number, number]

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * The contrast a rewritten colour has to reach.
 *
 * Not 4.5, which is the floor the rest of the site is held to: this is the
 * floor plus a margin. The audit that scores these pages compares a ratio it
 * computes itself, and a colour that clears 4.5:1 by one part in ten billion
 * would pass here and fail there. The headroom costs one or two units of one
 * channel on the colours that were already compliant — `#2e808f` becomes
 * `#2e7f8e` — which is not a difference a reader can see, and it buys an
 * unambiguous pass.
 */
const CONTRAST_TARGET = 4.6

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; `null` for anything else. */
export function parseHex(value: string): Rgba | null {
  if (!HEX.test(value)) return null

  const digits = value.slice(1)
  const short = digits.length <= 4
  const channels = short
    ? [...digits].map((digit) => parseInt(digit + digit, 16))
    : digits.match(/../g)!.map((pair) => parseInt(pair, 16))

  const [r, g, b, a] = channels
  if (r === undefined || g === undefined || b === undefined) return null

  return [r, g, b, a === undefined ? 1 : a / 255]
}

/** The shortest hex that round-trips, dropping the alpha when it is opaque. */
export function formatHex([r, g, b, a]: Rgba): string {
  const pair = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')

  return `#${pair(r)}${pair(g)}${pair(b)}${a < 1 ? pair(a * 255) : ''}`
}

/** Source-over compositing of a translucent colour onto an opaque one. */
export function composite(source: Rgba, backdrop: Rgba): Rgba {
  const alpha = source[3] + backdrop[3] * (1 - source[3])
  if (alpha === 0) return [0, 0, 0, 0]

  return [0, 1, 2]
    .map(
      (channel) =>
        ((source[channel] as number) * source[3] +
          (backdrop[channel] as number) * backdrop[3] * (1 - source[3])) /
        alpha,
    )
    .concat(alpha) as unknown as Rgba
}

/** WCAG 2.1 relative luminance. */
export function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  )
  return ((lighter as number) + 0.05) / ((darker as number) + 0.05)
}

/**
 * The nearest readable version of `hex` on `background`.
 *
 * Returns the input unchanged when it already clears the target or cannot be
 * understood; `null` never comes back, because a token colour is not a place to
 * fail a render over.
 */
export function contrastSafeHex(
  hex: string,
  background: string,
  target: number = CONTRAST_TARGET,
): string {
  const backdrop = parseHex(background)
  const source = parseHex(hex)
  if (!backdrop || !source) return hex

  const painted = source[3] < 1 ? composite(source, backdrop) : source
  if (contrastRatio(painted, backdrop) >= target) return hex

  // Text has to be opaque to be held to a text standard — see the note above
  // about 47% alpha on white being unable to reach the floor at all.
  const opaque: Rgba = [source[0], source[1], source[2], 1]
  const towardsWhite = luminance(painted) > luminance(backdrop)

  /*
   * The bisection searches over the colour that will be *written*, not over the
   * one it is computed from. That distinction is the whole reason this is not
   * three lines shorter: `formatHex` rounds, and a candidate sitting exactly on
   * the target rounds just as happily upwards as downwards. Searching in
   * floating point and rounding at the end therefore returns a colour that
   * misses the target it was solved for — by a hair, but this is a threshold
   * someone else re-measures, and being under it by a hair is being under it.
   */
  const quantised = (factor: number): Rgba =>
    parseHex(
      formatHex(
        [0, 1, 2]
          .map((channel) => {
            const value = opaque[channel] as number
            return value + (towardsWhite ? 255 - value : -value) * factor
          })
          .concat(1) as unknown as Rgba,
      ),
    )!

  // Monotonic in `factor`, so bisect for the point where it starts to pass.
  let tooLittle = 0
  let enough = 1
  for (let step = 0; step < 60; step++) {
    const middle = (tooLittle + enough) / 2
    if (contrastRatio(quantised(middle), backdrop) >= target) enough = middle
    else tooLittle = middle
  }

  return formatHex(quantised(enough))
}

/**
 * A copy of `theme` whose every foreground clears the contrast target.
 *
 * Returns the theme untouched when it declares no usable `editor.background`:
 * without a surface to judge against there is no measurement to make, and
 * guessing one would be worse than leaving the palette alone.
 */
export function makeContrastSafeTheme(
  theme: ThemeRegistration,
  target: number = CONTRAST_TARGET,
): ThemeRegistration {
  const background = theme.colors?.['editor.background']
  if (!background || !parseHex(background)) return theme

  const foreground = theme.colors?.['editor.foreground']

  return {
    ...theme,
    colors: theme.colors
      ? {
          ...theme.colors,
          ...(foreground
            ? { 'editor.foreground': contrastSafeHex(foreground, background, target) }
            : {}),
        }
      : theme.colors,
    tokenColors: theme.tokenColors?.map((token) => {
      const color = token.settings?.foreground
      if (!color) return token

      // A token that paints its own background is judged against that
      // background; the theme's is not what the reader sees behind it.
      const surface = token.settings?.background ?? background

      return {
        ...token,
        settings: {
          ...token.settings,
          foreground: contrastSafeHex(color, surface, target),
        },
      }
    }),
  }
}
