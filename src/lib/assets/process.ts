import 'server-only'

import sharp, { type OutputInfo, type Sharp } from 'sharp'
import type { SniffResult } from '@/lib/security/mime'
import { formatBytes } from '@/lib/utils/format'

/**
 * Image processing.
 *
 * Bytes in, bytes out. Nothing here touches the filesystem, the database, or a
 * URL, which is what lets the decisions below — how to orient, when a
 * derivative is not worth producing, how small a blur placeholder has to be —
 * be exercised without a server.
 *
 * The one rule that shapes the whole module: **the bytes produced here are the
 * bytes that get stored.** The original is re-encoded rather than passed
 * through, because a JPEG's GPS coordinates live in the same stream as its
 * pixels and there is no way to remove one without rewriting the other.
 */

export class ImageProcessingError extends Error {
  readonly code = 'IMAGE_PROCESSING'
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ImageProcessingError'
    this.cause = cause
  }
}

/* -------------------------------------------------------------------------- */
/*  Encoders                                                                   */
/* -------------------------------------------------------------------------- */

type Encoder = (pipeline: Sharp) => Sharp

/**
 * Formats sharp can both decode and re-encode in this build.
 *
 * `image/bmp` is absent on purpose, even though `sniffMime` accepts it: libvips
 * here has no BMP codec (checked against the running build, not assumed), so a
 * BMP is stored exactly as uploaded and that is recorded on the asset. Silently
 * turning it into a PNG would misreport the format we were handed.
 *
 * Quality numbers are per format, not per number. JPEG 90 and WebP 90 are not
 * the same picture, and AVIF 60 is roughly WebP 82 — reusing one figure
 * everywhere is how a derivative ends up visibly worse than what it replaces.
 */
const REENCODABLE: Record<string, Encoder> = {
  'image/png': (pipeline) => pipeline.png({ compressionLevel: 9 }),
  'image/jpeg': (pipeline) => pipeline.jpeg({ quality: 90 }),
  'image/webp': (pipeline) => pipeline.webp({ quality: 90 }),
  'image/avif': (pipeline) => pipeline.avif({ quality: 60 }),
  'image/tiff': (pipeline) => pipeline.tiff({ compression: 'deflate' }),
  'image/gif': (pipeline) => pipeline.gif(),
}

/** True when this module can decode the format and write it back out. */
export function canReencode(mime: string): boolean {
  return mime in REENCODABLE
}

export const DERIVATIVE_FORMATS = ['webp', 'avif'] as const
export type DerivativeFormat = (typeof DERIVATIVE_FORMATS)[number]

/* -------------------------------------------------------------------------- */
/*  Thumbnail                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Long edge of the thumbnail, in pixels.
 *
 * The admin's grid is four columns at its widest, so a cell is a little over
 * 200px across and a 2x display asks for a little over 400 device pixels; 480
 * covers that. It is deliberately not a second full-size download: a document's
 * images are laid out at content width, and a 480px file stretched to 760 is
 * blurry, which is why this is offered only where the box is small.
 */
export const THUMBNAIL_LONG_EDGE = 480

export interface ThumbnailDerivative {
  bytes: Buffer
  /** Dimensions of `bytes`, which are the original's scaled, not the row's. */
  width: number
  height: number
}

interface DerivativeEncoder {
  mime: string
  ext: string
  encode: Encoder
}

const DERIVATIVE_ENCODERS: Record<DerivativeFormat, DerivativeEncoder> = {
  webp: {
    mime: 'image/webp',
    ext: '.webp',
    // 82 is the point where WebP stops being distinguishable from the source on
    // a normal display, which is the only quality target a derivative has.
    encode: (pipeline) => pipeline.webp({ quality: 82 }),
  },
  avif: {
    mime: 'image/avif',
    ext: '.avif',
    // AVIF's scale does not match WebP's: 55 here is the same picture as WebP
    // 82, and copying that number across would produce a visibly softer image.
    encode: (pipeline) => pipeline.avif({ quality: 55 }),
  },
}

/* -------------------------------------------------------------------------- */
/*  Placeholder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Long edge of the blur placeholder, in pixels.
 *
 * The placeholder is stretched to the full display size by the browser, so it
 * only has to carry the composition — 20px on the long edge does that at a
 * payload measured in tens of bytes. Bigger stops being a placeholder and
 * becomes a second download.
 */
export const BLUR_LONG_EDGE = 20

/**
 * Ceiling on the placeholder's data URI.
 *
 * A data URI is inlined in the HTML of every page that shows the asset, so its
 * size is paid on the critical path. Past this it costs more than the layout
 * shift it prevents, and the honest answer is no placeholder at all.
 */
export const BLUR_MAX_DATA_URL_LENGTH = 2048

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface EncodedDerivative {
  format: DerivativeFormat
  mime: string
  ext: string
  bytes: Buffer
}

export interface SkippedDerivative {
  format: DerivativeFormat
  /** Why it was not produced, with the numbers that decided it. */
  reason: string
}

export interface ProcessedImage {
  /** The bytes to store: auto-oriented and free of metadata. */
  bytes: Buffer
  /** Dimensions of `bytes`, after the orientation was applied. */
  width: number | null
  height: number | null
  blurDataUrl: string | null
  averageColor: string | null
  derivatives: EncodedDerivative[]
  skippedDerivatives: SkippedDerivative[]
  /** Null when the image is already no larger than one, or could not be scaled. */
  thumbnail: ThumbnailDerivative | null
  /**
   * What SVG sanitisation removed. Always empty here — an SVG never reaches
   * this module — but present so `persistAsset` can treat the two preparation
   * paths as one shape rather than branching on which one it called.
   */
  sanitizationRemoved: string[]
  /** Decisions that are not about a derivative: a dropped blur, verbatim storage. */
  notes: string[]
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * True when the source has more than one frame.
 *
 * Its own function because it is a decision, not a detail: re-encoding an
 * animation through the single-frame path drops every frame but the first, and
 * the caller must be able to see and test that rule without a multi-frame
 * fixture to hand.
 */
export function isAnimated(metadata: { pages?: number | null }): boolean {
  return (metadata.pages ?? 1) > 1
}

/**
 * Prepare an uploaded buffer for storage.
 *
 * This is the only door into the pipeline, so the routing rules — SVG is not
 * an image here, an animated source is not re-encoded, a format with no codec
 * is stored as uploaded — are applied once rather than at each call site.
 */
export async function processImage(
  buffer: Buffer,
  sniff: SniffResult,
): Promise<ProcessedImage> {
  if (sniff.mime === 'image/svg+xml') {
    // A raw SVG must never reach storage. Refusing loudly is the point: the
    // failure mode being guarded against is a future caller who passes an SVG
    // straight through and serves it as trusted markup.
    throw new ImageProcessingError(
      'SVG is sanitised by @/lib/assets/svg before storage and must not be processed as an image',
    )
  }

  if (!canReencode(sniff.mime)) {
    return {
      bytes: buffer,
      width: null,
      height: null,
      blurDataUrl: null,
      averageColor: null,
      derivatives: [],
      skippedDerivatives: [],
      thumbnail: null,
      sanitizationRemoved: [],
      notes: [
        `stored as uploaded: this build has no decoder for ${sniff.mime}, so no metadata was stripped and no derivatives were produced`,
      ],
    }
  }

  const source = sharp(buffer)
  const metadata = await source.metadata().catch((error: unknown) => {
    throw new ImageProcessingError(
      `Cannot read ${sniff.mime} metadata: ${messageOf(error)}`,
      error,
    )
  })

  // Re-encoding an animation through the single-frame path silently drops every
  // frame but the first, and re-encoding it through the multi-frame path would
  // need the animated flag threaded through every stage below — for a format
  // that carries no EXIF GPS to strip in the first place. Storing it as
  // uploaded is the honest trade.
  if (isAnimated(metadata)) {
    return {
      bytes: buffer,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      blurDataUrl: null,
      averageColor: null,
      derivatives: [],
      skippedDerivatives: [],
      thumbnail: null,
      sanitizationRemoved: [],
      notes: [
        `stored as uploaded: ${metadata.pages} frames, and a still re-encode would drop all but the first`,
      ],
    }
  }

  return processStill(buffer, sniff)
}

async function processStill(
  buffer: Buffer,
  sniff: SniffResult,
): Promise<ProcessedImage> {
  const encoder = REENCODABLE[sniff.mime]
  if (!encoder) {
    throw new ImageProcessingError(`No encoder for ${sniff.mime}`)
  }

  /*
   * `.rotate()` with no angle, and without `.withMetadata()`, is the whole
   * orientation story:
   *
   *   - it reads the EXIF Orientation tag and applies it to the pixels, so a
   *     photo taken sideways comes out upright;
   *   - it drops the EXIF block, GPS included. Calling `.withMetadata()`
   *     anywhere in the chain undoes that — it is the only way to get the
   *     reader's home coordinates into the stored file, and it also re-adds an
   *     orientation tag that a browser would then apply a *second* time.
   *
   * Skipping `.rotate()` is the other classic breakage: the pixels stay
   * un-rotated while the tag that would have rotated them disappears, and every
   * portrait photo is served on its side.
   */
  const oriented = sharp(buffer).rotate()

  let encoded: { data: Buffer; info: OutputInfo }
  try {
    encoded = await encoder(oriented).toBuffer({ resolveWithObject: true })
  } catch (error) {
    // Nothing has been written yet, so there is no partial output to clean up:
    // the failure is reported and the caller stores nothing at all.
    throw new ImageProcessingError(
      `Failed to re-encode ${sniff.mime}: ${messageOf(error)}`,
      error,
    )
  }

  const bytes = encoded.data
  const width = encoded.info.width
  const height = encoded.info.height

  const skippedDerivatives: SkippedDerivative[] = []
  const derivatives: EncodedDerivative[] = []

  for (const format of DERIVATIVE_FORMATS) {
    const spec = DERIVATIVE_ENCODERS[format]
    try {
      // The source of every derivative is the stored original, so a derivative
      // is the same picture at the same size and can stand in for it in a
      // `<picture>` element without changing the layout.
      const candidate = await spec.encode(sharp(bytes)).toBuffer()

      if (candidate.length >= bytes.length) {
        // A second format that is bigger is not an optimisation: it is the same
        // image at a worse price, and a `<picture>` would pick it and get
        // slower. The decision is recorded on the asset rather than swallowed,
        // and the size comparison is the test — not a pixel count, because a
        // noisy 200x200 PNG can encode larger than a smooth 4000x3000 JPEG.
        skippedDerivatives.push({
          format,
          reason: `${format} would be ${formatBytes(candidate.length)} against a ${formatBytes(bytes.length)} original`,
        })
        continue
      }

      derivatives.push({
        format,
        mime: spec.mime,
        ext: spec.ext,
        bytes: candidate,
      })
    } catch (error) {
      // A missing codec must not fail the upload. Note that sharp's format
      // registry is not a reliable probe for this: this build reports
      // `sharp.format.avif.output.buffer === false` while the AVIF encoder
      // produces valid files, so the attempt itself is the only honest test.
      skippedDerivatives.push({
        format,
        reason: `${format} encoder unavailable: ${messageOf(error)}`,
      })
    }
  }

  const notes: string[] = []
  const blurDataUrl = await blurPlaceholder(bytes, notes)
  const averageColor = await averageColorOf(bytes)
  const thumbnail = await thumbnailOf(bytes, width, height, notes)

  return {
    bytes,
    width,
    height,
    blurDataUrl,
    averageColor,
    derivatives,
    skippedDerivatives,
    thumbnail,
    sanitizationRemoved: [],
    notes,
  }
}

/**
 * A copy scaled to fit the thumbnail box, or null with the reason in `notes`.
 *
 * Two reasons, and they are different kinds of thing. A failure is a codec
 * saying no, which must not fail the upload — the original is stored and the
 * grid falls back to serving it. A skip is a decision: an image that is already
 * within the box produces a file with the same pixels under a second name, and
 * the honest answer there is that this asset does not need a thumbnail.
 *
 * The output is compared against the original rather than the source metadata
 * being consulted, because sharp has already applied the EXIF orientation by
 * this point and the metadata's width and height may be the pre-rotation ones.
 */
async function thumbnailOf(
  bytes: Buffer,
  width: number,
  height: number,
  notes: string[],
): Promise<ThumbnailDerivative | null> {
  let encoded: { data: Buffer; info: OutputInfo }
  try {
    // The WebP encoder is the derivative one, so the quality is stated in a
    // single place: a thumbnail differs from a same-size derivative in its
    // dimensions, not in how careful the encoder is.
    encoded = await DERIVATIVE_ENCODERS.webp
      .encode(
        sharp(bytes)
          // `withoutEnlargement` is what makes the skip below the normal case
          // for a small image rather than an error: a 300x200 icon comes back
          // 300x200 rather than blown up to fit the box.
          .resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, {
            fit: 'inside',
            withoutEnlargement: true,
          }),
      )
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    notes.push(`thumbnail skipped: ${messageOf(error)}`)
    return null
  }

  // Nothing was scaled, so what came back is the original twice over: the same
  // pixels under a second name and a second URL. Compared against the stored
  // dimensions rather than the source metadata, because sharp has applied the
  // EXIF orientation by now and the metadata may hold the pre-rotation ones.
  if (encoded.info.width >= width && encoded.info.height >= height) {
    notes.push(
      `thumbnail skipped: at ${width}x${height} the image already fits the ${THUMBNAIL_LONG_EDGE}px box`,
    )
    return null
  }

  return {
    bytes: encoded.data,
    width: encoded.info.width,
    height: encoded.info.height,
  }
}

/* -------------------------------------------------------------------------- */
/*  Placeholder helpers                                                        */
/* -------------------------------------------------------------------------- */

async function blurPlaceholder(
  bytes: Buffer,
  notes: string[],
): Promise<string | null> {
  let encoded: Buffer
  try {
    encoded = await sharp(bytes)
      // `withoutEnlargement` is the same no-upscale rule the derivatives follow:
      // a 12px icon must not be blown up to 20px, which would cost bytes and
      // sharpen nothing.
      .resize(BLUR_LONG_EDGE, BLUR_LONG_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 40 })
      .toBuffer()
  } catch (error) {
    notes.push(`blur placeholder skipped: ${messageOf(error)}`)
    return null
  }

  const dataUrl = `data:image/webp;base64,${encoded.toString('base64')}`
  if (dataUrl.length > BLUR_MAX_DATA_URL_LENGTH) {
    notes.push(
      `blur placeholder skipped: ${formatBytes(dataUrl.length)} exceeds the ${formatBytes(BLUR_MAX_DATA_URL_LENGTH)} a placeholder may cost`,
    )
    return null
  }

  return dataUrl
}

/**
 * Average colour, as `#rrggbb`.
 *
 * Transparent pixels are composited onto white first: the frontend paints this
 * behind the image, and an averaged alpha channel is a colour nobody ever sees.
 */
async function averageColorOf(bytes: Buffer): Promise<string> {
  const pixel = await sharp(bytes)
    .flatten({ background: '#ffffff' })
    .resize(1, 1, { fit: 'fill' })
    .raw()
    .toBuffer()
    .catch((error: unknown) => {
      throw new ImageProcessingError(
        `Failed to reduce the image to its average colour: ${messageOf(error)}`,
        error,
      )
    })

  if (pixel.length < 3) {
    throw new ImageProcessingError(
      `Expected at least 3 channels from a 1x1 reduction, received ${pixel.length}`,
    )
  }

  const [r, g, b] = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0]
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
