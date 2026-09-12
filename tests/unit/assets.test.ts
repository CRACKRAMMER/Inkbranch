import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AssetTooLargeError,
  UnsupportedAssetError,
  UPLOAD_ROOT,
  UPLOAD_TMP_DIR,
  assetFilePaths,
  assetUrl,
  persistAsset,
  relativePathFromUrl,
  resolveAssetFile,
  sha256Of,
  storeAsset,
  storedRelativePath,
} from '@/lib/assets/storage'
import {
  AssetInUseError,
  deleteAsset,
  findAssetReferences,
  findUnusedAssets,
  isAssetInUse,
  referenceMatchKeys,
  updateAssetAlt,
} from '@/lib/assets/manage'
import {
  ImageProcessingError,
  THUMBNAIL_LONG_EDGE,
  isAnimated,
  processImage,
} from '@/lib/assets/process'
import {
  BLUR_LONG_EDGE,
  BLUR_MAX_DATA_URL_LENGTH,
  blurPlaceholderSource,
} from '@/lib/assets/blur'
import { env } from '@/env'
import { prepareSvg } from '@/lib/assets/svg'
import { documentUrl } from '@/lib/content/paths'
import { extractLinks, referencedImageKeys } from '@/lib/content/links'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import {
  assets,
  auditLogs,
  contentIndex,
  contentLinks,
  siteSettings,
  type AssetRow,
} from '@/lib/db/schema'
import { sniffMime } from '@/lib/security/mime'

import { hasTestDatabase } from '../setup'

/**
 * The asset store.
 *
 * The properties these tests hold it to, in the order they matter:
 *
 *   1. **A file's name is a function of its bytes.** Same bytes, same name;
 *      different bytes, different name; and the name is a SHA-256, so a URL
 *      cannot be walked to find what else is on the server.
 *   2. **The extension comes from the sniffed content.** A `.png` full of ZIP
 *      bytes is not a PNG, and a PNG named `holiday.zip` is.
 *   3. **Deleting is not silent.** Whatever a delete would break is reported
 *      before it happens.
 *
 * `tests/setup.ts` points `UPLOAD_DIR` at a throwaway directory. The assertion
 * below turns "I forgot" from a silent write into the repository's real
 * `public/uploads` into a loud failure.
 */
if (!UPLOAD_ROOT.startsWith(os.tmpdir())) {
  throw new Error(`Asset tests refuse to run against ${UPLOAD_ROOT}`)
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A uniform PNG. Lossless, so its pixels are exactly the colour asked for. */
async function makePng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number } = { r: 200, g: 40, b: 90 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer()
}

/** A JPEG carrying EXIF, orientation and all, as a camera would produce. */
async function makeJpegWithExif(
  width: number,
  height: number,
  orientation: number,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .jpeg({ quality: 90 })
    .withMetadata({
      orientation,
      // IFD0 is where a real camera puts the copyright and, in the GPS IFD it
      // points at, the coordinates. Its presence is what matters here: the
      // pipeline must not keep the block.
      exif: { IFD0: { Copyright: 'somebody' } },
    })
    .toBuffer()
}

/** Bytes that begin with a ZIP local file header, from a file called `.png`. */
function zipBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.alloc(32, 0x41),
  ])
}

/**
 * A 2x2 24-bit BMP, assembled by hand.
 *
 * `sniffMime` accepts BMP but this build of sharp cannot read it, which is the
 * branch being tested — so the fixture cannot come from sharp. A 14-byte file
 * header, a 40-byte DIB header, and four bottom-up rows padded to four bytes.
 */
function makeBmp(): Buffer {
  const pixels = Buffer.from([
    0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00,
    0xff, 0xff, 0xff, 0x00,
  ])
  const header = Buffer.alloc(14 + 40)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(header.length + pixels.length, 2)
  header.writeUInt32LE(header.length, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(2, 18)
  header.writeInt32LE(2, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixels.length, 34)
  return Buffer.concat([header, pixels])
}

/**
 * Every path under the upload root, sorted.
 *
 * Tests in one file share the directory, so "nothing was written" is a
 * comparison against the state before, not against an empty directory.
 */
async function treeSnapshot(): Promise<string[]> {
  const entries = await fs.readdir(UPLOAD_ROOT, { recursive: true })
  return entries.filter((entry) => !entry.startsWith('.tmp')).sort()
}

afterAll(async () => {
  // The temp root belongs to this test file; leaving hundreds of hash-named
  // files behind on every run is how a temp directory turns into a leak.
  await fs.rm(UPLOAD_ROOT, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/*  Content addressing                                                         */
/* -------------------------------------------------------------------------- */

describe('content-addressed storage', () => {
  it('gives the same bytes the same name and different bytes a different one', async () => {
    const bytes = await makePng(24, 24)
    const other = await makePng(24, 24, { r: 10, g: 220, b: 30 })

    const first = await persistAsset({ buffer: bytes, originalFilename: 'first.png' })
    const renamed = await persistAsset({ buffer: bytes, originalFilename: 'renamed.png' })
    const second = await persistAsset({ buffer: other, originalFilename: 'first.png' })

    expect(renamed.path).toBe(first.path)
    expect(renamed.sha256).toBe(first.sha256)
    expect(second.path).not.toBe(first.path)

    // The name is the hash of the file on disk and the extension the sniffer
    // derived, sharded two hex characters at a time.
    expect(first.path).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    const stored = await fs.readFile(first.absolutePath)
    expect(first.path).toContain(sha256Of(stored))
    expect(first.size).toBe(stored.length)
  })

  it('writes one file for two uploads of one file', async () => {
    const bytes = await makePng(40, 30)

    const first = await persistAsset({ buffer: bytes, originalFilename: 'a.png' })
    const again = await persistAsset({ buffer: bytes, originalFilename: 'b.png' })

    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.absolutePath).toBe(first.absolutePath)

    const shard = await fs.readdir(path.join(UPLOAD_ROOT, first.path.split('/')[0] ?? ''), {
      recursive: true,
    })
    const matches = shard.filter((name) => name.endsWith('.png'))
    expect(matches).toHaveLength(1)

    expect(await fs.readdir(UPLOAD_TMP_DIR)).toEqual([])
  })

  it('builds the public URL from the URL prefix and the stored path', async () => {
    const stored = await persistAsset({
      buffer: await makePng(16, 16),
      originalFilename: 'url.png',
    })
    expect(stored.url).toBe(assetUrl(stored.path))
    expect(stored.url.startsWith('/uploads/')).toBe(true)
    expect(relativePathFromUrl(stored.url)).toBe(stored.path)
  })

  it('refuses to build a path from anything that is not a digest or extension', () => {
    const digest = 'a'.repeat(64)
    expect(storedRelativePath(digest, '.png')).toBe(`aa/aa/${digest}.png`)

    // A name assembled from a caller's string is the whole class of bug this
    // store exists to avoid, so it is rejected rather than escaped.
    expect(() => storedRelativePath('../../etc/passwd', '.png')).toThrow()
    expect(() => storedRelativePath(digest, '/../../x')).toThrow()
    expect(() => storedRelativePath(digest, '.')).toThrow()
  })

  it('proves a resolved path stays inside the upload root', () => {
    expect(resolveAssetFile('ab/cd/file.png')).toBe(
      path.join(UPLOAD_ROOT, 'ab', 'cd', 'file.png'),
    )
    expect(() => resolveAssetFile('../../etc/passwd')).toThrow()
    // A leading slash is rebased rather than rejected: stored paths are written
    // both ways, and `/uploads/a.png` plainly means the upload in the upload
    // root. What is refused is the `..` above, because it is the only way out.
    expect(resolveAssetFile('/etc/passwd')).toBe(
      path.join(UPLOAD_ROOT, 'etc', 'passwd'),
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Sniffing                                                                   */
/* -------------------------------------------------------------------------- */

describe('type detection', () => {
  it('rejects a file whose extension lies about its contents', async () => {
    const before = await treeSnapshot()

    await expect(
      persistAsset({ buffer: zipBytes(), originalFilename: 'screenshot.png' }),
    ).rejects.toBeInstanceOf(UnsupportedAssetError)

    // The rejection happened before anything was written: a refused upload
    // leaves no file, and no temp file either.
    expect(await treeSnapshot()).toEqual(before)
    expect(await fs.readdir(UPLOAD_TMP_DIR)).toEqual([])
  })

  it('derives the extension from the sniff, not from the filename', async () => {
    const bytes = await makePng(20, 20)
    expect(sniffMime(bytes).ext).toBe('.png')

    const stored = await persistAsset({
      buffer: bytes,
      originalFilename: 'holiday.zip',
    })

    expect(stored.mime).toBe('image/png')
    expect(stored.path.endsWith('.png')).toBe(true)
    expect(stored.path.endsWith('.zip')).toBe(false)

    // The original name is kept, but only as a label: sanitised, and never
    // allowed anywhere near a path.
    expect(stored.filename).toBe('holiday.zip')
    expect(stored.absolutePath.endsWith('holiday.zip')).toBe(false)
  })

  it('names a file after the bytes it stored, not the bytes it received', async () => {
    const upload = await makeJpegWithExif(64, 40, 6)
    const stored = await persistAsset({ buffer: upload, originalFilename: 'photo.jpg' })
    const written = await fs.readFile(stored.absolutePath)

    expect(stored.sha256).toBe(sha256Of(written))
    expect(stored.path).toContain(stored.sha256)
    // Re-encoding to strip EXIF changed the bytes, so a name taken from the
    // upload would promise a file that is not there.
    expect(sha256Of(upload)).not.toBe(stored.sha256)
  })

  it('refuses to store an SVG through the image pipeline', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(sniffMime(bytes).mime).toBe('image/svg+xml')
    await expect(processImage(bytes, sniffMime(bytes))).rejects.toBeInstanceOf(
      ImageProcessingError,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Orientation and metadata                                                   */
/* -------------------------------------------------------------------------- */

describe('EXIF handling', () => {
  it('applies the orientation to the pixels and drops the EXIF block', async () => {
    const upload = await makeJpegWithExif(64, 40, 6)

    // Guard on the fixture: if sharp ever stops writing the tag, this test
    // would pass without exercising anything.
    const uploadMeta = await sharp(upload).metadata()
    expect(uploadMeta.orientation).toBe(6)
    expect(Boolean(uploadMeta.exif)).toBe(true)

    const stored = await persistAsset({ buffer: upload, originalFilename: 'rotated.jpg' })

    // Orientation 6 is "rotate 90° clockwise": a 64x40 photograph is displayed
    // as 40x64, and the recorded dimensions have to be the displayed ones.
    expect(stored.width).toBe(40)
    expect(stored.height).toBe(64)

    const written = await sharp(await fs.readFile(stored.absolutePath)).metadata()
    expect(written.width).toBe(40)
    expect(written.height).toBe(64)
    // Nothing left to leak: no GPS, no camera, no orientation tag that a
    // browser would apply a second time.
    expect(written.exif).toBeUndefined()
    expect(written.orientation).toBeUndefined()
  })

  it('does not carry the orientation tag onto a derivative', async () => {
    const upload = await makeJpegWithExif(1200, 800, 8)
    const stored = await persistAsset({ buffer: upload, originalFilename: 'wide.jpg' })

    expect(stored.variants.length).toBeGreaterThan(0)
    for (const variant of stored.variants) {
      const relative = relativePathFromUrl(variant.url)
      expect(relative).not.toBeNull()
      const meta = await sharp(
        await fs.readFile(resolveAssetFile(relative ?? '')),
      ).metadata()
      expect(meta.orientation).toBeUndefined()
      expect(meta.exif).toBeUndefined()
      expect(meta.width).toBe(800)
      expect(meta.height).toBe(1200)
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Placeholder and derivatives                                                */
/* -------------------------------------------------------------------------- */

describe('derivatives and placeholder', () => {
  it('produces both derivatives for a source large enough to benefit', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'large.jpg',
    })

    expect(stored.variants.map((variant) => variant.format).sort()).toEqual([
      'avif',
      'webp',
    ])

    for (const variant of stored.variants) {
      // A derivative that is not smaller is not a derivative. This is the rule
      // the code applies, checked here against the files it actually wrote.
      expect(variant.size).toBeLessThan(stored.size)
      const relative = relativePathFromUrl(variant.url)
      expect(relative).not.toBeNull()
      const stat = await fs.stat(resolveAssetFile(relative ?? ''))
      expect(stat.size).toBe(variant.size)
    }
  })

  it('skips a derivative that would only be larger, and says so', async () => {
    // A 32x32 PNG of one colour is 137 bytes; an AVIF of it is rather more,
    // because the format's header costs more than the picture.
    const stored = await persistAsset({
      buffer: await makePng(32, 32),
      originalFilename: 'icon.png',
    })

    expect(stored.width).toBe(32)
    expect(stored.height).toBe(32)

    for (const variant of stored.variants) {
      expect(variant.size).toBeLessThan(stored.size)
    }

    const skipped = stored.skippedDerivatives.map((entry) => entry.format)
    expect(skipped).toContain('avif')
    for (const entry of stored.skippedDerivatives) {
      expect(entry.reason.length).toBeGreaterThan(0)
    }

    // The decision is recorded on the row's variants by omission, and in the
    // return value in words: an admin asking "where is my AVIF" gets an answer.
    expect(stored.variants.some((variant) => variant.format === 'avif')).toBe(
      skipped.includes('avif') ? false : true,
    )
  })

  it('records the true pixel dimensions rather than the declared ones', async () => {
    const stored = await persistAsset({
      buffer: await makePng(37, 91),
      originalFilename: 'odd.png',
    })
    expect(stored.width).toBe(37)
    expect(stored.height).toBe(91)
  })

  it('writes a placeholder small enough to be worth inlining', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'hero.jpg',
    })

    const dataUrl = stored.blurDataUrl
    expect(dataUrl).toMatch(/^data:image\/webp;base64,/)
    expect(dataUrl?.length ?? 0).toBeLessThanOrEqual(BLUR_MAX_DATA_URL_LENGTH)

    const meta = await sharp(base64Payload(dataUrl ?? '')).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(BLUR_LONG_EDGE)
  })

  it('does not enlarge a placeholder for a source smaller than it', async () => {
    const stored = await persistAsset({
      buffer: await makePng(12, 12),
      originalFilename: 'tiny.png',
    })

    const meta = await sharp(base64Payload(stored.blurDataUrl ?? '')).metadata()
    expect(meta.width).toBe(12)
    expect(meta.height).toBe(12)
  })
})

/* -------------------------------------------------------------------------- */
/*  The placeholder a renderer may paint                                       */
/* -------------------------------------------------------------------------- */

/*
 * The other half of the placeholder, and the reason it is a module of its own:
 * the encoder above produces one, and the renderer below decides whether the
 * one it is handed may be written into a `style` attribute. The value there
 * comes from a database column, so the answer cannot be "the pipeline wrote it".
 */
describe('blurPlaceholderSource', () => {
  const VALID = `data:image/webp;base64,${'A'.repeat(48)}`

  it('accepts what the pipeline writes and wraps it as a url()', () => {
    expect(blurPlaceholderSource(VALID)).toBe(`url(${VALID})`)
  })

  it('says nothing for an image that has no placeholder', () => {
    // Null is the ordinary answer, not a failure: an SVG has none by
    // construction and a row written before the column existed has none either.
    for (const value of [null, undefined, '']) {
      expect(blurPlaceholderSource(value)).toBeNull()
    }
  })

  it.each([
    ['a URL that has to be fetched', 'https://example.com/pixel.png'],
    ['a protocol that runs something', 'javascript:alert(1)'],
    ['a data URI of something that is not an image', 'data:text/html;base64,PHNjcmlwdD4='],
    // The declaration-breakout case: a `;` here would end the property and make
    // the rest a declaration of its own.
    ['a value that carries a second declaration', `${VALID};background:url(https://e.com/p)`],
    ['a value with whitespace in it', `data:image/webp;base64,AAAA BBBB`],
    ['a value with a quote in it', `data:image/webp;base64,AAA"BBB`],
    ['a value that only contains a data URI', `prefix ${VALID}`],
    ['a value past the ceiling', `data:image/webp;base64,${'A'.repeat(BLUR_MAX_DATA_URL_LENGTH)}`],
    // The URL-safe alphabet is deliberately not accepted: this site's encoder
    // writes standard base64, so anything else is a value it did not produce,
    // and the cost of refusing is a missing placeholder rather than a page.
    ['a URL-safe base64 value', `data:image/webp;base64,${'A-_'.repeat(16)}`],
  ])('refuses %s', (_case, value) => {
    expect(blurPlaceholderSource(value)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Thumbnail                                                                  */
/* -------------------------------------------------------------------------- */

describe('the thumbnail', () => {
  it('scales a large image into the box and keeps its shape', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'wide.jpg',
    })

    const thumbnail = stored.thumbnail
    expect(thumbnail).not.toBeNull()
    expect(thumbnail?.width).toBe(THUMBNAIL_LONG_EDGE)
    // 1200x800 is 3:2, so the box's long edge lands on the width and the height
    // follows. A thumbnail that changed the shape would reflow the grid it was
    // made for.
    expect(thumbnail?.height).toBe(320)

    // Measured from the file, not from the record: a row saying 480 is worth
    // nothing if the bytes on disk are something else.
    const relative = relativePathFromUrl(thumbnail?.url ?? '')
    expect(relative).not.toBeNull()
    const onDisk = await fs.readFile(resolveAssetFile(relative ?? ''))
    const meta = await sharp(onDisk).metadata()

    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(480)
    expect(meta.height).toBe(320)
    expect(thumbnail?.size).toBe(onDisk.length)
    expect(thumbnail?.size).toBeLessThan(stored.size)
  })

  it('scales a portrait image by its long edge, not its width', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(600, 1800, 1),
      originalFilename: 'tall.jpg',
    })

    expect(stored.thumbnail?.width).toBe(160)
    expect(stored.thumbnail?.height).toBe(THUMBNAIL_LONG_EDGE)
  })

  it('leaves an image that already fits the box alone, and says why', async () => {
    const stored = await persistAsset({
      buffer: await makePng(400, 300),
      originalFilename: 'small.png',
    })

    expect(stored.width).toBe(400)
    expect(stored.thumbnail).toBeNull()
    // The reason is on the record rather than inferred from the absence: an
    // admin looking for a thumbnail is told there was nothing to make one from,
    // which is a different answer from a failure.
    expect(stored.notes.some((note) => note.includes('thumbnail skipped'))).toBe(true)
    expect(stored.notes.some((note) => note.includes('already fits'))).toBe(true)
  })

  it('names the file after its own bytes, whatever the original is called', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'holiday.jpg',
    })

    const relative = relativePathFromUrl(stored.thumbnail?.url ?? '')
    const bytes = await fs.readFile(resolveAssetFile(relative ?? ''))
    // The same content addressing as everything else: the URL is a hash of what
    // was written, so a thumbnail cannot be walked to either.
    expect(relative).toBe(storedRelativePath(sha256Of(bytes), '.webp'))
    expect(relative).not.toContain('holiday')
  })

  it('counts as one of the files the asset owns', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'wide.jpg',
    })

    const files = assetFilePaths({
      path: stored.path,
      variants: stored.variants,
      thumbnail: stored.thumbnail,
    })

    // Original, two formats, one thumbnail. A list that missed the thumbnail
    // would leave it on disk forever after a delete — invisible, because the
    // database is the only manifest the upload directory has.
    expect(files).toHaveLength(4)
    for (const file of files) {
      await expect(fs.stat(resolveAssetFile(file))).resolves.toBeDefined()
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  SVG                                                                        */
/* -------------------------------------------------------------------------- */

describe('SVG sanitisation', () => {
  const hostile = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">',
    '<script>alert(document.domain)</script>',
    '<rect width="20" height="20" fill="#f00" onload="alert(1)"/>',
    '<a xlink:href="javascript:alert(2)"><text x="1" y="1">x</text></a>',
    '</svg>',
  ].join('')

  it('stores a sanitised SVG and never the upload', async () => {
    const stored = await persistAsset({
      buffer: Buffer.from(hostile, 'utf8'),
      originalFilename: 'logo.svg',
    })

    const written = await fs.readFile(stored.absolutePath, 'utf8')

    expect(stored.mime).toBe('image/svg+xml')
    expect(stored.path.endsWith('.svg')).toBe(true)
    expect(written).not.toContain('<script')
    expect(written).not.toContain('alert')
    expect(written).not.toContain('javascript:')
    expect(written).toContain('<rect')

    // What was stripped travels with the result: sanitise, report, store the
    // clean version — the admin sees what the file lost.
    expect(stored.sanitizationRemoved).toContain('script')
    expect(stored.sanitizationRemoved.length).toBeGreaterThan(0)

    const onDisk = sha256Of(Buffer.from(written, 'utf8'))
    expect(stored.sha256).toBe(onDisk)
  })

  it('gives a vector no raster placeholder and no derivatives', async () => {
    const stored = await persistAsset({
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      originalFilename: 'empty.svg',
    })

    expect(stored.blurDataUrl).toBeNull()
    expect(stored.variants).toEqual([])
    // Rasterising a vector to 480px would turn the one form that is sharp at
    // every size into a form that is sharp at one.
    expect(stored.thumbnail).toBeNull()
    expect(stored.notes.length).toBeGreaterThan(0)
  })

  it('refuses markup that sanitises down to nothing usable', () => {
    expect(() => prepareSvg(Buffer.from('   '))).toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/*  References                                                                 */
/* -------------------------------------------------------------------------- */

describe('which documents reference an asset', () => {
  /** The keys a scanner would store for a document using this asset. */
  function keysForAsset(stored: {
    url: string
    variants: { url: string }[]
  }, markdown: string): string[] {
    const { links } = extractLinks(markdown, { uploadUrlPrefix: '/uploads' })
    // `referencedImageKeys` is what the sync engine reduces the scan to, so the
    // keys compared below are the ones actually written to `content_links`.
    return referencedImageKeys(links)
  }

  it('matches the keys the Markdown scanner produces, variants included', async () => {
    const stored = await persistAsset({
      buffer: await makeJpegWithExif(1200, 800, 1),
      originalFilename: 'diagram.jpg',
    })
    const variant = stored.variants[0]
    expect(variant).toBeDefined()
    expect(stored.thumbnail).not.toBeNull()

    // Every form the scanner recognises: a Markdown image, a raw `<img>`
    // pointing at a derivative rather than at the original — which is what a
    // `<picture>` element's fallback does — and one pointing at the thumbnail.
    const markdown = [
      `![The diagram](${stored.url})`,
      '',
      `<img src="${variant?.url}" alt="derivative">`,
      '',
      `<img src="${stored.thumbnail?.url}" alt="thumbnail">`,
    ].join('\n')

    const scanned = keysForAsset(stored, markdown)
    expect(scanned.length).toBeGreaterThanOrEqual(3)

    const matches = referenceMatchKeys({
      path: stored.path,
      url: stored.url,
      variants: stored.variants,
      thumbnail: stored.thumbnail,
    })

    // Every way a document can name this asset is in the set the delete check
    // looks for, including the derivative URL that appears on its own in a
    // `<source srcset>` and the thumbnail URL, which is printed on the asset's
    // page and can be pasted into a document like any other URL there.
    for (const key of scanned) {
      expect(matches).toContain(key)
    }
  })

  it('does not match a reference to a different asset', async () => {
    const stored = await persistAsset({
      buffer: await makePng(20, 20),
      originalFilename: 'one.png',
    })
    const other = await persistAsset({
      buffer: await makePng(20, 20, { r: 1, g: 2, b: 3 }),
      originalFilename: 'two.png',
    })

    const scanned = keysForAsset(
      other,
      `![other](${other.url})`,
    )
    const matches = referenceMatchKeys({
      path: stored.path,
      url: stored.url,
      variants: stored.variants,
      thumbnail: stored.thumbnail,
    })

    expect(scanned.some((key) => matches.includes(key))).toBe(false)
  })

  it('counts a site avatar as a use, with no document to point at', () => {
    const document = {
      id: '00000000-0000-0000-0000-000000000000',
      type: 'post' as const,
      slug: 'hello',
      title: 'Hello',
      status: 'published' as const,
      via: 'link' as const,
      href: '/posts/hello',
    }

    expect(isAssetInUse({ documents: [], usedAsSiteAvatar: false })).toBe(false)
    expect(isAssetInUse({ documents: [document], usedAsSiteAvatar: false })).toBe(
      true,
    )
    // Deleting the avatar without a word would be the same silent breakage as
    // deleting an image a post shows.
    expect(isAssetInUse({ documents: [], usedAsSiteAvatar: true })).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  The reference query, against a database                                    */
/* -------------------------------------------------------------------------- */

/**
 * The block above checks the rules the reference query applies. These check the
 * query itself, joining `content_links`, `content_index` and `site_settings`,
 * and the delete that consults it — SQL over three tables cannot be exercised
 * without them, and a delete that refuses at the wrong moment is exactly the
 * failure worth catching.
 *
 * They run only when `TEST_DATABASE_URL` is set, like the settings and revision
 * suites. Every row is created here under a unique prefix and removed in
 * `afterAll`, so the assertions are about this file's fixtures rather than about
 * whatever else is in the database.
 */
describe.skipIf(!hasTestDatabase)('references against a database', () => {
  const RUN = `assetref-${Date.now().toString(36)}`
  const contentIds: string[] = []
  const assetIds: string[] = []
  let postCount = 0
  let imageCount = 0

  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  afterAll(async () => {
    // Links go with their document (on delete cascade). Assets go through the
    // store so their files leave the upload root as well.
    if (contentIds.length > 0) {
      await db.delete(contentIndex).where(inArray(contentIndex.id, contentIds))
    }
    for (const id of assetIds) {
      await deleteAsset(id, { force: true }).catch(() => undefined)
    }
    // Then the history those fixtures wrote. The log is append-only in the
    // application, but a suite that leaves a growing pile of its own audit rows
    // in a shared database makes the next run's counts meaningless.
    if (assetIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.targetId, assetIds))
    }
  })

  async function seedDocument(
    fields: { cover?: string; ogImage?: string } = {},
  ) {
    postCount += 1
    const slug = `${RUN}-${postCount}`
    const [row] = await db
      .insert(contentIndex)
      .values({
        type: 'post',
        slug,
        path: `posts/${slug}.md`,
        title: `Fixture ${postCount}`,
        status: 'published',
        checksum: sha256Of(Buffer.from(slug, 'utf8')),
        ...fields,
      })
      .returning()

    if (!row) throw new Error('the fixture document was not inserted')
    contentIds.push(row.id)
    return row
  }

  async function linkImage(sourceId: string, targetKey: string): Promise<void> {
    await db.insert(contentLinks).values({
      sourceId,
      kind: 'image',
      href: targetKey,
      targetKey,
    })
  }

  /**
   * An asset with a real row and a real file, distinct from every other.
   *
   * Large enough to be scaled, so it has a thumbnail as well as derivatives: an
   * asset in these tests is a row with four files behind it, and a fixture too
   * small to be resized would leave the newest of them out of every assertion
   * about what a delete touches. The colour is what makes each fixture distinct
   * — identical bytes would be the same asset.
   */
  async function storeImage(name: string): Promise<AssetRow> {
    imageCount += 1
    const stored = await storeAsset({
      buffer: await makePng(1200, 800, { r: imageCount, g: 20, b: 30 }),
      originalFilename: name,
    })
    assetIds.push(stored.asset.id)
    return stored.asset
  }

  it('finds the document behind a Markdown image link', async () => {
    const asset = await storeImage('linked.png')
    const document = await seedDocument()
    await linkImage(document.id, asset.path)

    const usage = await findAssetReferences(asset.id)

    expect(usage?.documents).toHaveLength(1)
    expect(usage?.documents[0]).toMatchObject({
      id: document.id,
      slug: document.slug,
      status: 'published',
      via: 'link',
      href: documentUrl('post', document.slug),
    })
    expect(usage?.usedAsSiteAvatar).toBe(false)
  })

  it('finds a document that names only a derivative', async () => {
    const stored = await storeAsset({
      buffer: await makeJpegWithExif(900, 600, 1),
      originalFilename: 'with-derivatives.jpg',
    })
    assetIds.push(stored.asset.id)

    const variant = stored.asset.variants[0]
    expect(variant).toBeDefined()

    const document = await seedDocument()
    // A `<picture>` whose AVIF source is the only place the asset is named: if
    // the query matched the original's path alone, this asset would look unused.
    await linkImage(document.id, relativePathFromUrl(variant?.url ?? '') ?? '')

    const usage = await findAssetReferences(stored.asset.id)
    expect(usage?.documents.map((entry) => entry.slug)).toEqual([document.slug])
  })

  it('finds frontmatter images, which the link scanner never sees', async () => {
    const asset = await storeImage('cover.png')
    const covering = await seedDocument({ cover: asset.url })
    const sharing = await seedDocument({ ogImage: asset.url })

    const usage = await findAssetReferences(asset.id)

    // Both fields, and which document each belongs to: removing the wrong one
    // would leave the other pointing at a file that is about to disappear.
    const via = new Map(usage?.documents.map((entry) => [entry.via, entry.slug]))
    expect(via.get('cover')).toBe(covering.slug)
    expect(via.get('ogImage')).toBe(sharing.slug)
    expect(usage?.usedAsSiteAvatar).toBe(false)
  })

  it('refuses to delete an image a document still shows, and changes nothing', async () => {
    const asset = await storeImage('in-use.png')
    const document = await seedDocument()
    await linkImage(document.id, asset.path)

    const refusal = await deleteAsset(asset.id).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(AssetInUseError)
    expect((refusal as AssetInUseError).usage.documents[0]?.slug).toBe(
      document.slug,
    )

    // A refusal that had already removed something would be worse than no
    // check at all, so every file the asset occupies is still there afterwards.
    for (const file of assetFilePaths(asset)) {
      await expect(fs.access(resolveAssetFile(file))).resolves.toBeUndefined()
    }

    const [denied] = await db
      .select({ outcome: auditLogs.outcome })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'asset.delete'),
          eq(auditLogs.targetId, asset.id),
        ),
      )
    expect(denied?.outcome).toBe('denied')
  })

  it('deletes a forced asset, its files and its audit row', async () => {
    const asset = await storeImage('doomed.png')
    // The original, the two formats and the thumbnail. Asserted before the
    // delete, so a fixture that lost its thumbnail cannot make the loop below
    // pass by having nothing to check.
    const files = assetFilePaths(asset)
    expect(files).toHaveLength(4)

    const result = await deleteAsset(asset.id, { force: true })

    for (const file of files) {
      expect(result.filesRemoved).toContain(file)
      await expect(fs.access(resolveAssetFile(file))).rejects.toThrow()
    }
    expect(await findAssetReferences(asset.id)).toBeNull()
  })

  it('counts the site avatar as a reason to refuse, with no document to list', async () => {
    const asset = await storeImage('avatar.png')

    const [previous] = await db
      .select({ avatarUrl: siteSettings.avatarUrl })
      .from(siteSettings)
      .limit(1)

    try {
      await db
        .insert(siteSettings)
        .values({ id: 'default', avatarUrl: asset.url })
        .onConflictDoUpdate({
          target: siteSettings.id,
          set: { avatarUrl: asset.url },
        })

      const usage = await findAssetReferences(asset.id)
      expect(usage).toMatchObject({ usedAsSiteAvatar: true })
      expect(usage?.documents).toEqual([])

      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
    } finally {
      // The settings row is shared with every other suite, so it is put back the
      // way it was found rather than deleted.
      if (previous) {
        await db
          .update(siteSettings)
          .set({ avatarUrl: previous.avatarUrl })
          .where(eq(siteSettings.id, 'default'))
      } else {
        await db.delete(siteSettings).where(eq(siteSettings.id, 'default'))
      }
    }
  })

  it('sets an alt text, clears it, and records both', async () => {
    const asset = await storeImage('described.png')

    const set = await updateAssetAlt(asset.id, 'A red square', { actorId: null })
    expect(set).toMatchObject({ id: asset.id, alt: 'A red square' })

    const [readBack] = await db
      .select({ alt: assets.alt })
      .from(assets)
      .where(eq(assets.id, asset.id))
    expect(readBack?.alt).toBe('A red square')

    // Whitespace is not a description and neither is an empty string: both mean
    // the author has not written one yet, and a reader has nothing to announce.
    const cleared = await updateAssetAlt(asset.id, '   ')
    expect(cleared?.alt).toBeNull()

    const rows = await db
      .select({ meta: auditLogs.meta })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'asset.update'), eq(auditLogs.targetId, asset.id)))
      .orderBy(auditLogs.createdAt)

    // Two edits, two rows — the second is the one that says a description was
    // removed rather than written, which the asset row alone cannot tell you.
    expect(rows).toHaveLength(2)
    expect(rows[0]?.meta).toMatchObject({ field: 'alt', cleared: false, length: 12 })
    expect(rows[1]?.meta).toMatchObject({ field: 'alt', cleared: true, length: 0 })

    // A stale dialog is the ordinary way to reach this, not an error.
    expect(await updateAssetAlt(randomUUID(), 'gone')).toBeNull()
  })

  it('proposes the unreferenced assets and not the referenced ones', async () => {
    const orphan = await storeImage('orphan.png')
    const used = await storeImage('used.png')
    const document = await seedDocument()
    await linkImage(document.id, used.path)

    const unused = await findUnusedAssets({ limit: 1000 })
    const ids = unused.map((row) => row.id)

    expect(ids).toContain(orphan.id)
    expect(ids).not.toContain(used.id)
  })
})

/* -------------------------------------------------------------------------- */
/*  Formats with no decoder                                                    */
/* -------------------------------------------------------------------------- */

describe('formats this build cannot decode', () => {
  it('stores a BMP as uploaded and records that nothing was stripped', async () => {
    const bytes = makeBmp()

    const stored = await persistAsset({ buffer: bytes, originalFilename: 'old.bmp' })

    expect(stored.mime).toBe('image/bmp')
    // Verbatim: sharp cannot read BMP here, and turning it into a PNG would
    // report a format we were not handed. The pixel dimensions are unknown for
    // the same reason, and saying so is better than guessing.
    expect(await fs.readFile(stored.absolutePath)).toEqual(bytes)
    expect(stored.width).toBeNull()
    expect(stored.height).toBeNull()
    expect(stored.blurDataUrl).toBeNull()
    expect(stored.variants).toEqual([])
    expect(stored.notes.join(' ')).toContain('stored as uploaded')
  })

  it('stores a PDF as uploaded', async () => {
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from('%%EOF\n', 'latin1'),
    ])

    const stored = await persistAsset({ buffer: bytes, originalFilename: 'notes.pdf' })

    expect(stored.mime).toBe('application/pdf')
    expect(stored.size).toBe(bytes.length)
    expect(stored.notes.join(' ')).toContain('no decoder')
  })

  it('re-encodes a still GIF, which this build can decode', async () => {
    const gif = await sharp(await makePng(80, 50)).gif().toBuffer()
    expect(sniffMime(gif).mime).toBe('image/gif')

    const stored = await persistAsset({ buffer: gif, originalFilename: 'loop.gif' })

    expect(stored.mime).toBe('image/gif')
    expect(stored.path.endsWith('.gif')).toBe(true)
    expect(stored.width).toBe(80)
    expect(stored.height).toBe(50)
  })

  it('never treats a single-frame source as an animation', () => {
    // The rule that keeps frames from being dropped is a one-liner, and it is
    // the one-liner that would be wrong in a way nobody notices: the stored
    // file would look fine and be missing everything after the first frame.
    expect(isAnimated({ pages: undefined })).toBe(false)
    expect(isAnimated({ pages: null })).toBe(false)
    expect(isAnimated({ pages: 1 })).toBe(false)
    expect(isAnimated({ pages: 2 })).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  Guards                                                                     */
/* -------------------------------------------------------------------------- */

describe('guards', () => {
  it('rejects an empty upload without writing anything', async () => {
    await expect(
      persistAsset({ buffer: Buffer.alloc(0), originalFilename: 'nothing.png' }),
    ).rejects.toBeInstanceOf(UnsupportedAssetError)

    expect(await fs.readdir(UPLOAD_TMP_DIR)).toEqual([])
  })

  it('refuses an upload past MAX_UPLOAD_SIZE before sniffing it', async () => {
    const oversized = Buffer.alloc(env.MAX_UPLOAD_SIZE + 1)

    await expect(
      persistAsset({ buffer: oversized, originalFilename: 'huge.png' }),
    ).rejects.toBeInstanceOf(AssetTooLargeError)

    expect(await fs.readdir(UPLOAD_TMP_DIR)).toEqual([])
  })
})

function base64Payload(dataUrl: string): Buffer {
  const [, payload] = dataUrl.split(',')
  if (!payload) throw new Error(`Not a data URI: ${dataUrl.slice(0, 40)}`)
  return Buffer.from(payload, 'base64')
}
