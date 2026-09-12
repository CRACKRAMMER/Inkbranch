/**
 * Build the site's favicon.
 *
 * The icon is a brand square with a hash on it — the same mark the site uses for
 * a tag — and it is drawn here rather than exported from a design tool because
 * a binary in `src/app/` with no source is a thing nobody can change later. The
 * shape is four rectangles and one rounded corner; it does not need Illustrator.
 *
 *   pnpm brand:icons        # writes src/app/favicon.ico
 *
 * No external rasteriser. The first version of this file shelled out to
 * `rsvg-convert` and `magick`, which meant the asset could only be rebuilt on a
 * machine that happened to have both — and ImageMagick wrote the ICO entries as
 * uncompressed BMPs, which made a 1.6 KB icon into a 15 KB one. Rasterising here
 * is about eighty lines of arithmetic and removes both problems.
 *
 * The result is written as PNG-encoded ICO entries, which every browser that
 * reads `.ico` at all has understood since IE11. That, not the rendering, is
 * where the 15 KB → 2 KB comes from.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The canvas the geometry below is written against, as the SVG's viewBox was. */
const VIEW = 32

/** Brand square, and the cream it is drawn on. The same pair as `globals.css`. */
const BRAND = [0x8a, 0x4c, 0x00] as const
const CREAM = [0xfd, 0xfc, 0xfb] as const

/** The rounded square's corner radius, on the 32-unit canvas. */
const RADIUS = 7

/**
 * The hash, as rectangles: two uprights and two crossbars.
 *
 * They overlap at the corners, which is why this is composited as a union
 * rather than drawn in order — a bar does not replace what it crosses.
 */
const BARS: readonly [number, number, number, number][] = [
  [11, 6.5, 3, 19],
  [18, 6.5, 3, 19],
  [6.5, 11, 19, 3],
  [6.5, 18, 19, 3],
]

/**
 * How many samples per axis each output pixel is averaged from.
 *
 * The only curve in the icon is the corner radius, and at 16px a hard-edged
 * corner is the difference between a designed mark and a broken one. Four is
 * enough that no corner pixel lands on a half-covered boundary it cannot
 * express, and small enough to stay instant.
 */
const SUPERSAMPLE = 4

type Rgba = [number, number, number, number]

/** True when a point is inside the rounded square that fills the canvas. */
function insideSquare(x: number, y: number): boolean {
  const r = RADIUS
  // The corner circles' centres, one per quadrant.
  const cx = x < r ? r : x > VIEW - r ? VIEW - r : x
  const cy = y < r ? r : y > VIEW - r ? VIEW - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** True when a point falls in any of the bars. */
function insideHash(x: number, y: number): boolean {
  for (const [bx, by, bw, bh] of BARS) {
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return true
  }
  return false
}

/**
 * Render one size, antialiased.
 *
 * Coverage is sampled rather than computed analytically, and the samples are
 * averaged in premultiplied alpha so that a pixel half on the edge and half off
 * it does not pick up colour from the transparent side.
 */
function render(size: number): Rgba[] {
  const pixels: Rgba[] = new Array(size * size)
  const scale = VIEW / size
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale

          if (!insideSquare(x, y)) continue

          const [cr, cg, cb] = insideHash(x, y) ? CREAM : BRAND
          // Premultiplied: a covered sample contributes its colour and an
          // alpha of 1, an uncovered one contributes neither.
          r += cr
          g += cg
          b += cb
          a += 1
        }
      }

      if (a === 0) {
        pixels[py * size + px] = [0, 0, 0, 0]
        continue
      }

      // Un-premultiply for storage: PNG holds straight alpha.
      pixels[py * size + px] = [
        Math.round(r / a),
        Math.round(g / a),
        Math.round(b / a),
        Math.round((a / samples) * 255),
      ]
    }
  }

  return pixels
}

/* -------------------------------------------------------------------------- */
/*  PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An 8-bit RGBA PNG with no filtering; the rows are already smooth. */
function encodePng(size: number, pixels: Rgba[]): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x]!
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* -------------------------------------------------------------------------- */
/*  ICO                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * An ICO whose entries are whole PNG files.
 *
 * The container changed nothing when it was extended this way — an entry is
 * still an offset and a length into the same file — so the only thing to get
 * right is the directory. A dimension of 0 means 256; none of these reach it,
 * but the convention is worth stating where it is not obvious.
 */
function encodeIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(images.length * 16)
  let offset = header.length + directory.length

  images.forEach((image, index) => {
    const entry = index * 16
    directory[entry] = image.size >= 256 ? 0 : image.size
    directory[entry + 1] = image.size >= 256 ? 0 : image.size
    directory[entry + 2] = 0 // palette size; 0 for true colour
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

const sizes = [16, 32, 48]
const images = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }))

const ico = encodeIco(images)
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/app/favicon.ico',
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, ico)

const detail = images.map((i) => `${i.size}px ${i.png.length}B`).join(', ')
console.log(`wrote ${out}`)
console.log(`  ${ico.length} bytes total (${detail})`)
