import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createElement, type ReactElement } from 'react'
import { ImageResponse } from 'next/og'
import { charWidth, displayWidth } from '@/lib/utils/text'
import { OG_IMAGE_SIZE, type SiteIdentity } from './metadata'

/**
 * Generated Open Graph cards.
 *
 * The card is one restrained panel: a hairline border, a small label, the
 * title, and a footer with the site name and the document's terms. No gradient,
 * no glass, no hero — at the size a card is actually seen, in a timeline or a
 * chat preview, a border and a type hierarchy are the only things that read.
 *
 * ## The font
 *
 * The font that ships with `ImageResponse` has no CJK glyphs, so a Chinese
 * title renders as a row of empty boxes. `public/fonts/NotoSansSC-Regular-subset.ttf`
 * is a Noto Sans SC Regular subset built once and committed, so nothing is
 * fetched at request time and no deployment depends on the host having a CJK
 * font installed. It covers GB2312's 6763 hanzi plus Latin, CJK punctuation and
 * fullwidth forms — 2.3 MB, against 10 MB for the full face. Characters outside
 * GB2312 (rare variants, extended ideographs) are left to the renderer's
 * fallback. The file is read from `public/`, which every Next deployment ships.
 *
 * Rebuilt with:
 *
 *   curl -L -o NotoSansSC-VF.ttf \
 *     https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf
 *   python3 -m fontTools.varLib.instancer NotoSansSC-VF.ttf wght=400 -o NotoSansSC-Regular.ttf
 *   pyftsubset NotoSansSC-Regular.ttf --unicodes-file=unicodes.txt \
 *     --output-file=NotoSansSC-Regular-subset.ttf --no-hinting --desubroutinize \
 *     --layout-features='kern,liga,clig,calt,locl' \
 *     --drop-tables+=DSIG,BASE,vhea,vmtx,STAT,gasp --name-IDs=1,2,3,4,6
 *
 * `unicodes.txt` is ASCII, Latin-1, Latin Extended-A, general punctuation,
 * arrows, CJK symbols and punctuation, fullwidth forms, and every character
 * GB2312 can encode. The variable font's default instance is Thin, so the
 * instancer step is not optional. Licence: SIL OFL 1.1, in
 * `public/fonts/LICENSE-OFL.txt`.
 *
 * ## Fitting the title
 *
 * Satori does not break a line between two Chinese characters, so a long
 * Chinese title is one unbroken run that runs off the card. The wrapping is
 * therefore done here, in `layoutTitle`, and the renderer is handed lines that
 * already fit. A fixed-height title block with `overflow: hidden` is the second
 * line of defence: if a measurement is off, the title is clipped, never
 * spilled over the footer.
 */

/* -------------------------------------------------------------------------- */
/*  Font                                                                       */
/* -------------------------------------------------------------------------- */

const FONT_FAMILY = 'Noto Sans SC'
const FONT_FILE = 'NotoSansSC-Regular-subset.ttf'

/** `public/` is part of every deployment, so the font travels with the code. */
export const OG_FONT_PATH = path.join(process.cwd(), 'public', 'fonts', FONT_FILE)

let fontPromise: Promise<Buffer | null> | undefined

/**
 * The subset, read once per process.
 *
 * Cached as a promise rather than a value so concurrent first requests share
 * one read instead of racing to start several. A missing file is reported and
 * then remembered as missing — retrying the read on every card would put a
 * failed `open` in the path of every social preview for no chance of a
 * different answer.
 */
export function loadOgFont(): Promise<Buffer | null> {
  fontPromise ??= readOgFont()
  return fontPromise
}

async function readOgFont(): Promise<Buffer | null> {
  try {
    return await readFile(OG_FONT_PATH)
  } catch (error) {
    console.warn(
      `OG image font missing at ${OG_FONT_PATH} (${
        error instanceof Error ? error.message : String(error)
      }). Cards will render with the built-in font, which has no CJK glyphs.`,
    )
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

const PADDING_X = 76
const PADDING_Y = 64
const CONTENT_WIDTH = OG_IMAGE_SIZE.width - PADDING_X * 2

/** Title sizes, tried in order until one fits. */
const LARGEST_TITLE_SIZE = 72
const SMALLEST_TITLE_SIZE = 42
const TITLE_SIZES = [LARGEST_TITLE_SIZE, 60, 50, SMALLEST_TITLE_SIZE]
const TITLE_LINES = 3
const TITLE_LINE_HEIGHT = 1.22

/** Fixed height for the title block, so short and long cards share a rhythm. */
const TITLE_BLOCK_HEIGHT = Math.round(
  LARGEST_TITLE_SIZE * TITLE_LINE_HEIGHT * TITLE_LINES,
)

/**
 * Room one half-width unit takes, as a fraction of the font size.
 *
 * A CJK character is one em by definition, and `displayWidth` counts it as two
 * units, so this is really "how wide is a Latin character on average". Just
 * over half an em is the honest figure for a UI sans; the extra is deliberate,
 * because being wrong in this direction wraps a little early and being wrong in
 * the other one puts text outside the image.
 */
const HALF_WIDTH_EM = 0.56

/** Half-width units that fit on one line at `fontSize`. */
export function unitsPerLine(fontSize: number, contentWidth = CONTENT_WIDTH): number {
  return Math.max(1, Math.floor(contentWidth / (fontSize * HALF_WIDTH_EM)))
}

interface Token {
  text: string
  /** True when a space separated this token from the one before it. */
  spaceBefore: boolean
  width: number
}

/**
 * Split text into the smallest pieces a line may break between.
 *
 * A Latin word is one token, because breaking inside it is a typo. A CJK
 * character is its own token, because that is where Chinese and Japanese line
 * breaking happens — there are no spaces to break at.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let wordSpaceBefore = false
  let afterSpace = false

  const pushWord = (): void => {
    if (!word) return
    tokens.push({ text: word, spaceBefore: wordSpaceBefore, width: displayWidth(word) })
    word = ''
  }

  for (const char of input) {
    if (char === ' ') {
      pushWord()
      afterSpace = true
      continue
    }
    if (charWidth(char) === 2) {
      pushWord()
      tokens.push({ text: char, spaceBefore: afterSpace, width: 2 })
      afterSpace = false
      continue
    }
    if (!word) wordSpaceBefore = afterSpace
    afterSpace = false
    word += char
  }

  pushWord()
  return tokens
}

function joinTokens(tokens: readonly Token[]): string {
  let out = ''
  for (const [index, token] of tokens.entries()) {
    if (index > 0 && token.spaceBefore) out += ' '
    out += token.text
  }
  return out
}

/**
 * Break one token too wide for a whole line — a long URL, usually — on code
 * point boundaries, so it never runs past the edge and never splits a surrogate
 * pair.
 */
function splitToken(token: Token, maxWidth: number): Token[] {
  const pieces: Token[] = []
  let current = ''
  let width = 0

  for (const char of token.text) {
    const next = width + charWidth(char)
    if (current && next > maxWidth) {
      pieces.push({ text: current, spaceBefore: pieces.length === 0 && token.spaceBefore, width })
      current = ''
      width = 0
    }
    current += char
    width += charWidth(char)
  }
  if (current) {
    pieces.push({ text: current, spaceBefore: pieces.length === 0 && token.spaceBefore, width })
  }
  return pieces
}

/** Trim a line until the ellipsis fits beside it. */
function ellipsise(line: string, maxWidth: number): string {
  const points = Array.from(line)
  let width = 0
  let end = 0
  for (const point of points) {
    const next = width + charWidth(point)
    // Two units for the ellipsis: in a CJK font it is a full square.
    if (next > maxWidth - 2) break
    width = next
    end += 1
  }
  return `${points.slice(0, end).join('').trimEnd()}…`
}

/** Greedy wrap. Returns at most `maxLines` lines, ellipsised if it ran over. */
export function wrapTitle(
  tokens: readonly Token[],
  maxWidth: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let current: Token[] = []

  const flush = (): void => {
    if (current.length > 0) lines.push(joinTokens(current))
    current = []
  }

  for (const token of tokens) {
    const pieces = token.width > maxWidth ? splitToken(token, maxWidth) : [token]
    for (const [index, piece] of pieces.entries()) {
      // Only the first piece keeps the original leading space; the rest begin
      // a line and must not start with one.
      const candidate = index === 0 ? piece : { ...piece, spaceBefore: false }
      if (current.length > 0 && displayWidth(joinTokens([...current, candidate])) > maxWidth) {
        flush()
        current = [{ ...candidate, spaceBefore: false }]
      } else {
        current.push(candidate)
      }
    }
  }
  flush()

  if (lines.length <= maxLines) return { lines, truncated: false }

  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1] ?? ''
  kept[maxLines - 1] = ellipsise(last, maxWidth)
  return { lines: kept, truncated: true }
}

export interface TitleLayout {
  fontSize: number
  lines: string[]
  /** True when even the smallest size needed more than `TITLE_LINES` lines. */
  truncated: boolean
}

/**
 * Pick a size for the title and break it into lines.
 *
 * Scaling and clipping are both needed: scaling alone leaves a very long title
 * too small to read, and clipping alone cuts titles that would have fitted one
 * size down.
 */
export function layoutTitle(
  title: string,
  contentWidth = CONTENT_WIDTH,
): TitleLayout {
  const tokens = tokenize(title.replace(/\s+/g, ' ').trim())

  for (const fontSize of TITLE_SIZES) {
    const wrapped = wrapTitle(tokens, unitsPerLine(fontSize, contentWidth), TITLE_LINES)
    if (!wrapped.truncated) {
      return { fontSize, lines: wrapped.lines, truncated: false }
    }
  }

  // Nothing fits: the smallest size, cut off at the third line.
  const wrapped = wrapTitle(
    tokens,
    unitsPerLine(SMALLEST_TITLE_SIZE, contentWidth),
    TITLE_LINES,
  )
  return { fontSize: SMALLEST_TITLE_SIZE, lines: wrapped.lines, truncated: true }
}

/* -------------------------------------------------------------------------- */
/*  Render                                                                     */
/* -------------------------------------------------------------------------- */

export interface OgImageInput {
  title: string
  site: SiteIdentity
  /** Small label in the corner: `post`, `note`, `project`. */
  label?: string | null
  publishedAt?: Date | null
  tags?: readonly string[]
}

/** Beyond three, terms stop being information and start being noise. */
const MAX_TAGS = 3

/**
 * One hour in a shared cache, a day at the edge, and a week of grace while the
 * next one is rendered. A card only changes when the document does, and the URL
 * carries the title, so a longer edge life would be safe — but a corrected
 * title should not take a week to reach a chat preview.
 */
const CACHE_CONTROL =
  'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

export async function renderOgImage(input: OgImageInput): Promise<ImageResponse> {
  const { site } = input
  const title = input.title.trim() || site.name
  const layout = layoutTitle(title)
  const font = await loadOgFont()

  const label = (input.label ?? '').trim()
  const date = input.publishedAt
    ? input.publishedAt.toISOString().slice(0, 10)
    : ''
  const tags = (input.tags ?? []).slice(0, MAX_TAGS).join('  ·  ')

  const header = createElement(
    'div',
    {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        fontSize: 22,
        color: '#71717a',
      },
    },
    createElement(
      'span',
      { style: { textTransform: 'uppercase', letterSpacing: '0.18em' } },
      label,
    ),
    createElement('span', { style: { letterSpacing: '0.04em' } }, date),
  )

  const titleBlock = createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        height: TITLE_BLOCK_HEIGHT,
        overflow: 'hidden',
      },
    },
    ...layout.lines.map((line, index) =>
      createElement(
        'div',
        {
          key: `line-${index}`,
          style: {
            fontSize: layout.fontSize,
            lineHeight: TITLE_LINE_HEIGHT,
            letterSpacing: '-0.01em',
            color: '#111113',
          },
        },
        line,
      ),
    ),
  )

  const footer = createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    createElement('div', {
      style: { height: 1, backgroundColor: '#e4e4e7', marginBottom: 26 },
    }),
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 24,
        },
      },
      createElement('span', { style: { color: '#18181b' } }, site.name),
      createElement('span', { style: { color: '#71717a' } }, tags),
    ),
  )

  const card: ReactElement = createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#ffffff',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: '#e4e4e7',
        padding: `${PADDING_Y}px ${PADDING_X}px`,
        fontFamily: FONT_FAMILY,
        color: '#18181b',
      },
    },
    header,
    titleBlock,
    footer,
  )

  return new ImageResponse(card, {
    ...OG_IMAGE_SIZE,
    headers: { 'cache-control': CACHE_CONTROL },
    ...(font
      ? {
          fonts: [
            {
              name: FONT_FAMILY,
              data: font,
              weight: 400 as const,
              style: 'normal' as const,
            },
          ],
        }
      : {}),
  })
}
