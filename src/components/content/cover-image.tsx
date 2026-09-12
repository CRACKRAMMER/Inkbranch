import type { DocumentImage } from '@/lib/markdown/rehype-enhance'

/**
 * A document's cover, at the head of its body.
 *
 * ## Why this is not the body's image path
 *
 * The Markdown pipeline builds its own `<picture>` in `rehype-enhance`, but it
 * only ever sees images the *body* references. A cover lives in frontmatter, so
 * by the time the pipeline runs it is not in the input at all — the page has to
 * render it, which means assembling here the same three things the pipeline
 * assembles there: the formats the asset was also stored in, the intrinsic size
 * that stops the page shifting, and the wrapper that lets CSS lay it out.
 * `describeImage` in `@/lib/content/render` is the shared half.
 *
 * ## Why it loads eagerly
 *
 * Every image inside an article is `loading="lazy"`, and deliberately so — the
 * layout reserves their space from the asset row, so deferring them costs no
 * shift. A cover is the page's lead image and usually its largest, which is the
 * profile of an LCP element: marking it lazy invites the browser to defer the
 * one image whose arrival the reader is waiting on. It is fetched eagerly and
 * declared high priority for that reason.
 *
 * ## Why the alt text is empty
 *
 * There is no `coverAlt` in the frontmatter schema, and inventing one from the
 * title would be worse than an empty attribute: the `<h1>` sits immediately
 * above this image, so a screen reader would announce the same words twice. An
 * empty `alt` says "decorative, nothing here that the surrounding text does not
 * already say", which is the honest description of a cover on a page whose
 * title precedes it. Give the schema a `coverAlt` and this is the line to
 * change.
 */
export function CoverImage({
  href,
  image,
}: {
  /** The URL as the frontmatter wrote it. */
  href: string
  /** What the asset row knows, or null when it is not one of ours. */
  image: DocumentImage | null
}) {
  const img = (
    /*
      `next/image` is deliberately not used anywhere on this site: the upload
      pipeline already writes AVIF and WebP at ingest, and offering them here as
      `<source>` elements costs one indexed query. The optimiser would add a
      second encoding path, a cache directory and a decode per request to
      produce bytes that are already on disk. The full reasoning is under
      图片 and 资产 in DELIVERY.md.
    */
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={href}
      alt=""
      loading="eager"
      fetchPriority="high"
      decoding="async"
      /*
        Only when the row knows them. An external cover, or one whose row has
        gone, is rendered without dimensions rather than with an invented
        aspect ratio — a wrong width/height is worse than none, because the
        browser reserves the wrong box and then shifts.
      */
      {...(image?.width != null ? { width: image.width } : {})}
      {...(image?.height != null ? { height: image.height } : {})}
      className="h-auto max-w-full rounded-sm border border-line"
    />
  )

  return (
    <div className="mb-10">
      {image && image.sources.length > 0 ? (
        <picture>
          {image.sources.map((source) => (
            <source key={source.url} type={source.type} srcSet={source.url} />
          ))}
          {img}
        </picture>
      ) : (
        img
      )}
    </div>
  )
}
