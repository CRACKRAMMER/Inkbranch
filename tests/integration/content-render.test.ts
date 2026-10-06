import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasTestDatabase, testContentRoot } from '../setup'

import { UPLOAD_ROOT, assetFilePaths, storeAsset } from '@/lib/assets/storage'
import { readDocument } from '@/lib/content/reader'
import { describeImage, documentImages, renderDocument } from '@/lib/content/render'
import { renderMarkdown } from '@/lib/markdown/renderer'
import { db } from '@/lib/db'
import { indexSlugKeys } from '@/lib/admin/queries'
import { runMigrations } from '@/lib/db/migrate'
import { assets, contentIndex } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'

/**
 * A document rendered with what the database knows about it: its images, and
 * the documents its wiki links name.
 *
 * ## Why this is an integration test
 *
 * The renderer's half of this is a unit test — hand it a description and it
 * emits a `<picture>`. What no unit test can show is that the description is
 * the one the *row* holds: that the size in the `width` attribute is the size
 * the uploader measured, and that the URLs in the `<source>` list are the files
 * the derivative step actually wrote. Those are agreements between three
 * modules — the scanner, the asset store and the renderer — and the failure
 * they guard against is silent: a picture offering a URL that 404s looks like a
 * picture, and a `width` that is merely plausible keeps the layout from
 * jumping in a test and lets it jump in production.
 *
 * The wiki links below are here for a sharper version of the same reason. The
 * rule they follow — `[[why-not-catch]]` names a document whose *slug* is a
 * whole sentence, because the file is what a person goes looking for — is one
 * the sync engine has to apply when it writes the edge and the renderer has to
 * apply when it writes the anchor. Those two are the same function now, and the
 * only way to prove it is to let the engine index a real file and then render
 * what comes back.
 *
 * ## The fixture
 *
 * Noise, generated at run time rather than a committed picture, for two
 * reasons. A derivative is kept only when it is strictly smaller than the
 * stored original, so the picture has to be one the derived formats win on —
 * and by a margin wide enough that the assertion is about the pipeline rather
 * than about two encoders agreeing by a kilobyte. At this fixture's size the
 * noise is about 361 KB as PNG against 86 KB as WebP and 76 KB as AVIF.
 *
 * And it is different bytes every run, because an upload is stored under the
 * hash of its contents: a fixed fixture is deduplicated onto the row a previous
 * run created, and these tests would then be asserting about a row this run did
 * not write — the one shape of stale state that survives the database outliving
 * the upload directory.
 */

const storedAssets: string[] = []

/**
 * A picture of pure entropy, sized past the point where the encoders differ.
 *
 * Random bytes rather than the seeded generator a test would normally reach
 * for, and not out of fastidiousness: a linear congruential generator's output
 * is correlated enough that the PNG filters compress it well, and then the
 * lossy encoders — which cannot exploit that structure — come out *larger* than
 * the PNG. Measured at this size: 19 KB as PNG, 86 KB as WebP. No derivative
 * survives the size test, `variants` is empty, and every assertion below would
 * be about an empty list while the fixture looked random on inspection.
 */
async function noisyPng(width = 400, height = 300): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** Store a fixture and remember it, so cleanup can remove its rows and files. */
async function store(bytes: Buffer) {
  const result = await storeAsset({
    buffer: bytes,
    originalFilename: 'noisy.png',
    alt: 'A noisy fixture',
  })
  storedAssets.push(result.asset.sha256)
  return result
}

describe.skipIf(!hasTestDatabase)('a document and its images', () => {
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
  afterAll(async () => {
    if (storedAssets.length === 0) return

    const rows = await db
      .select()
      .from(assets)
      .where(inArray(assets.sha256, storedAssets))
      .catch(() => [])

    await db
      .delete(assets)
      .where(inArray(assets.sha256, storedAssets))
      .catch(() => undefined)

    // Every file, not just the original: a derivative left behind would be
    // found by the next run's `persistAsset` — bytes on disk with no row — and
    // would make its `created` flag disagree with itself.
    for (const row of rows) {
      for (const file of assetFilePaths(row)) {
        await fs.rm(path.join(UPLOAD_ROOT, file), { force: true })
      }
    }
  })

  it('describes an image by the spelling the document used', async () => {
    const { asset } = await store(await noisyPng())

    // The fixture's own precondition, asserted rather than assumed: with no
    // derivatives there is nothing to describe and every assertion below would
    // be about an empty list.
    expect(asset.variants.length).toBeGreaterThan(0)

    const images = await documentImages(`![A noisy fixture](${asset.url})\n`)

    // Keyed by the URL as written, not by the storage path: the spelling is
    // what the renderer sees when it arrives at the `<img>`.
    expect([...images.keys()]).toEqual([asset.url])

    const described = images.get(asset.url)
    expect(described?.width).toBe(asset.width)
    expect(described?.height).toBe(asset.height)

    // Best codec first, and only formats the row actually holds. A browser
    // takes the first source it understands, so this order is the decision.
    expect(described?.sources.map((source) => source.type)).toEqual([
      'image/avif',
      'image/webp',
    ])
    // And the URL of each one is the URL the store wrote for that format,
    // read off the row rather than rebuilt here — the point is that the
    // rendered attribute and the stored file are the same string.
    expect(described?.sources.map((source) => source.url)).toEqual(
      ['avif', 'webp'].map(
        (format) => asset.variants.find((variant) => variant.format === format)?.url,
      ),
    )
  })

  it('maps two spellings of one file to one description', async () => {
    const { asset } = await store(await noisyPng(401, 301))

    // The legacy prefix, which the scanner accepts on the way in because the
    // files never moved when the route did. Two spellings of one file are two
    // keys and must still be one picture.
    const legacy = `uploads/${asset.path}`
    const body = `![One](${asset.url})\n\n![Again](${legacy})\n`

    const images = await documentImages(body)

    expect([...images.keys()].sort()).toEqual([asset.url, legacy].sort())
    // The same object, not an equal one: a second description built from the
    // same row would be a second lookup nobody asked for, and identity is the
    // only assertion that notices the difference.
    expect(images.get(legacy)).toBe(images.get(asset.url))
  })

  it('says nothing about images that are not ours', async () => {
    const body = [
      '![Elsewhere](https://example.com/photo.png)',
      '',
      // Ours by URL prefix, but no row: an asset deleted from the library whose
      // article still references it.
      `![Gone](${'/uploads/ff/ff/'}${'0'.repeat(64)}.png)`,
    ].join('\n')

    const images = await documentImages(body)
    expect(images.size).toBe(0)

    // Absence is an absence of change. Compared against a render with no map
    // at all rather than against a hand-written string, because that is the
    // exact claim: the loader's silence leaves the output untouched.
    const loaded = await renderDocument(body)
    const plain = await renderMarkdown(body)
    expect(loaded.html).toBe(plain.html)
  })

  it('renders the formats the row holds and keeps the original as the image', async () => {
    const { asset } = await store(await noisyPng(402, 302))

    const { html } = await renderDocument(`![A noisy fixture](${asset.url})\n`)

    expect(html).toContain('<picture>')
    for (const variant of asset.variants) {
      expect(html).toContain(`srcset="${variant.url}"`)
      expect(html).toContain(`type="image/${variant.format}"`)
    }

    // The `<img>` is the stored original and stays where the author put it.
    // Rewriting it to a derivative would risk a broken image to save bytes; an
    // offer the browser may decline cannot break anything.
    expect(html).toContain(`<img src="${asset.url}"`)
    for (const variant of asset.variants) {
      expect(html).not.toContain(`<img src="${variant.url}"`)
    }

    // The box is reserved from the row, which is what makes the picture safe to
    // lazy-load: the layout is known before a byte of it arrives.
    expect(html).toContain(`width="${asset.width}"`)
    expect(html).toContain(`height="${asset.height}"`)
  })

  it('paints the placeholder the row holds, and not one it invented', async () => {
    const { asset } = await store(await noisyPng(405, 305))

    const { html } = await renderDocument(`![A noisy fixture](${asset.url})\n`)

    // The value is the upload pipeline's, from ingest: it is the same data URI
    // the admin asset page reports the size of, and the reader's browser paints
    // it into the box the attributes above reserved.
    expect(asset.blurDataUrl).toMatch(/^data:image\/webp;base64,/)
    expect(html).toContain(`--md-blur:url(${asset.blurDataUrl})`)
  })

  /*
   * The column is a text field. Everything the site writes into it comes from
   * `process.ts`, which is what the guard in `blurPlaceholderSource` would
   * rather not have to assume: this test writes what a hand-edited row — or a
   * future producer with a bug — could, and asserts that the page is unchanged.
   */
  it('does not paint a placeholder a row cannot be trusted with', async () => {
    const { asset } = await store(await noisyPng(406, 306))
    const body = `![A noisy fixture](${asset.url})\n`

    const rejected = [
      // A remote URL is a request every reader's browser would make, and the
      // one shape of leak this project refuses everywhere else.
      'https://example.com/pixel.png',
      // A value that ends the declaration and starts one of its own.
      'data:image/webp;base64,AAAA;background-image:url(https://example.com/pixel.png)',
      // The right shape and the wrong thing.
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      // Past the ceiling a placeholder may cost, which is paid on every page
      // that shows the asset.
      `data:image/webp;base64,${'A'.repeat(2048)}`,
    ]

    for (const value of rejected) {
      await db.update(assets).set({ blurDataUrl: value }).where(eq(assets.path, asset.path))

      const { html } = await renderDocument(body)

      expect(html).not.toContain('--md-blur')
      expect(html).not.toContain('example.com')
      // Refusing the placeholder does not change the image: it is still the
      // stored original, still sized from the row, still a `<picture>`.
      expect(html).toContain(`<img src="${asset.url}"`)
      expect(html).toContain(`width="${asset.width}"`)
    }
  })

  /*
   * A cover is an image reference in frontmatter rather than in the body, so
   * the scanner above never sees it — the page resolves it on its own. These
   * pin the one property that makes that safe: the answer is the same one the
   * body's images get. A second resolution path that agreed with the first
   * about the size and disagreed about the formats would be a cover offering a
   * URL that was never written, which is a broken image rather than a heavier
   * one.
   */
  it('describes a cover exactly as it would describe the same image in a body', async () => {
    const { asset } = await store(await noisyPng(403, 303))

    const cover = await describeImage(asset.url)
    const inBody = (await documentImages(`![A noisy fixture](${asset.url})\n`)).get(asset.url)

    // `toEqual` rather than a field-by-field comparison: the claim is that the
    // two paths agree about *everything*, so a field added to `DocumentImage`
    // later has to show up in both or this fails.
    expect(cover).toEqual(inBody)
    expect(cover?.width).toBe(asset.width)
  })

  it('resolves a cover written with the legacy prefix', async () => {
    const { asset } = await store(await noisyPng(404, 304))

    // The same spelling the scanner accepts on the way in, and which the two
    // prompts in the frontmatter schema both have to keep accepting — an author
    // who set a cover before the route moved must not lose it.
    expect(await describeImage(`uploads/${asset.path}`)).toEqual(
      await describeImage(asset.url),
    )
  })

  it('says nothing about a cover that is not ours', async () => {
    // Null is the whole answer, and the pages render the URL as written on it.
    expect(await describeImage('https://example.com/hero.png')).toBeNull()
    expect(await describeImage(`/uploads/ff/ff/${'0'.repeat(64)}.png`)).toBeNull()
    expect(await describeImage(null)).toBeNull()
    expect(await describeImage(undefined)).toBeNull()
    expect(await describeImage('')).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Wiki links                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The note is named for the *file*, and its slug is derived from the title.
 *
 * That gap is the whole fixture. Every human writing a link to this note writes
 * `why-not-catch` — the name of the file sitting in the directory — while the
 * route that serves it is the sentence. Only an index holding both spellings
 * can turn the first into the second, and only a real sync can show that it
 * does.
 */
const NOTE_TITLE = 'An empty catch block is a claim that nothing can go wrong'
const NOTE_SLUG = 'an-empty-catch-block-is-a-claim-that-nothing-can-go-wrong'

const WIKI_POST = `---
title: Wiki Source
slug: wiki-source
date: 2026-09-01
---

The same argument as [[why-not-catch]], one level down. This one names nothing
at all — [[nobody-wrote-this]] — and stays as it was typed. And this is an
example of a wiki link rather than one:

\`\`\`md
[[why-not-catch]]
\`\`\`
`

const WIKI_NOTE = `---
title: ${NOTE_TITLE}
date: 2026-09-02
---

Swallowing an error deletes information at the one moment it exists.
`

const WIKI_PATHS = ['posts/wiki-source.md', 'posts/why-not-catch.md']

describe.skipIf(!hasTestDatabase)('a document and its wiki links', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    const dir = path.join(testContentRoot, 'posts')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'wiki-source.md'), WIKI_POST, 'utf8')
    await fs.writeFile(path.join(dir, 'why-not-catch.md'), WIKI_NOTE, 'utf8')

    // The real engine, one document at a time: the index rows this test renders
    // from are the rows `syncOneDocument` writes, not ones the test typed.
    const { syncOneDocument } = await import('@/lib/content/sync')
    for (const relativePath of WIKI_PATHS) {
      expect(await syncOneDocument(relativePath)).not.toBeNull()
    }
  })

  afterAll(async () => {
    await db.delete(contentIndex).where(inArray(contentIndex.path, WIKI_PATHS))
    await fs.rm(path.join(testContentRoot, 'posts'), { recursive: true, force: true })
  })

  /** The body of the fixture post, as the page reads it off disk. */
  async function wikiPostBody(): Promise<string> {
    const document = await readDocument('posts/wiki-source.md')
    expect(document).not.toBeNull()
    return document?.body ?? ''
  }

  it('turns a wiki link into a link to the document the index says it names', async () => {
    const { html } = await renderDocument(await wikiPostBody())

    // One link, and it is the right one. Asserted as the whole list rather than
    // as a `toContain`, because the interesting failures are extra links: the
    // example inside the fence being rewritten, or the target nobody wrote
    // being turned into a link to a 404.
    expect(hrefsToPosts(html)).toEqual([`/posts/${NOTE_SLUG}`])
    // And the words are the author's, not the slug's.
    expect(html).toContain('>why-not-catch</a>')
  })

  it('uses public route keys so the editor accepts existing links and flags missing ones', async () => {
    const known = new Set(await indexSlugKeys())
    expect(known.has(`posts/${NOTE_SLUG}`)).toBe(true)
    const body = `${await wikiPostBody()}\n\n[Missing project](/projects/preview-missing)`
    const { html } = await renderDocument(body, { knownSlugs: known })
    expect(html).not.toContain(`data-broken-target="posts/${NOTE_SLUG}"`)
    expect(html).toContain('data-broken-target="projects/preview-missing"')
  })

  it('leaves a wiki link that names nothing as the text it was written as', async () => {
    const { html } = await renderDocument(await wikiPostBody())

    expect(html).toContain('[[nobody-wrote-this]]')
    expect(html).not.toContain('nobody-wrote-this</a>')
  })

  it('leaves an example inside a fence as an example', async () => {
    const { html } = await renderDocument(await wikiPostBody())

    // The example names the same document the prose link above does, so the
    // only reason it is not a link is that the scanner skipped it — and the
    // count in the first test is what proves that. This one says the characters
    // are still on the page: read as text, because the highlighter wraps every
    // token in a `<span>` and the literal is not contiguous in the HTML.
    expect(textOf(html)).toContain('[[why-not-catch]]')
  })

  it('renders the same body unchanged when there is nothing to resolve', async () => {
    // The loader's silence leaves the output untouched, the same claim the
    // image half makes: a document with no wiki link in it must come out of
    // `renderDocument` exactly as it came out of `renderMarkdown`.
    const body = 'No links here, only [[ and ]] separately.\n'
    const loaded = await renderDocument(body)
    const plain = await renderMarkdown(body)
    expect(loaded.html).toBe(plain.html)
  })
})

/** Every site-relative document URL in a rendered document, in order. */
function hrefsToPosts(html: string): string[] {
  return [...html.matchAll(/href="(\/posts\/[^"]*)"/g)].map((match) => match[1] ?? '')
}

/**
 * Rendered HTML with its tags removed — what the page says, rather than how it
 * is marked up. Syntax highlighting puts a `<span>` around every token, so the
 * literal text of a code block is not contiguous in the HTML.
 */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}
