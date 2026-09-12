import { requireUser } from '@/lib/auth/session'
import { buildRelativePath } from '@/lib/content/paths'
import { readDocument } from '@/lib/content/reader'
import { renderDocument } from '@/lib/content/render'
import { CONTENT_TYPES, type ContentType } from '@/lib/content/schema'
import { escapeXml } from '@/lib/seo/rss'
import { isValidSlug } from '@/lib/utils/slug'

/**
 * Draft preview.
 *
 * Renders a document from disk exactly as the reader would see it, whatever its
 * status — which is the whole point and also the whole risk: this is the one
 * route that will happily serve a document nothing has published yet. It is
 * therefore behind `requireUser`, and behind it *first*, before any parameter is
 * read and before anything touches the filesystem. A signed-out request is
 * redirected to the login page with this URL as its destination, so the author
 * lands back on the draft they were checking.
 *
 * ## Why it is not the published page
 *
 * It could be `/posts/x?preview=1`, and that would inherit the site's stylesheet
 * for free. It is not, because a query parameter on a public route is a
 * standing invitation to leak a draft: caching middleware, a CDN rule or one
 * forgotten status check in the page is all it takes, and the failure mode is
 * an unpublished document served to a stranger. A separate path under `/api/`,
 * which `robots.txt` already disallows wholesale, has no such surface.
 *
 * The cost is the styling: Next emits the site's stylesheet at build time under
 * a hashed name that a route handler cannot know, so the shell below carries a
 * few rules of its own instead of pretending to be the published page. It is a
 * reading surface, not a mock-up — the typography is close enough to judge a
 * paragraph and the structure is the renderer's own HTML, which is what the
 * draft will be judged on.
 *
 * ## Indexing
 *
 * `noindex` twice over: the header, which every crawler that matters obeys, and
 * a meta tag, which survives the HTML being saved or cached by something that
 * drops headers. `private, no-store` keeps a draft out of every shared cache
 * between here and its author.
 */

/** Same-site destination for the login redirect; `safeNext` re-checks it. */
function loginReturnTo(url: URL): string {
  return `${url.pathname}${url.search}`
}

function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value)
}

/** Plain text, uncached: this route's own errors, not the document's. */
function failure(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** A date as `YYYY-MM-DD`, or a dash when the frontmatter has none. */
function isoDay(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '—'
}

/**
 * The reading shell.
 *
 * Escaping is `escapeXml`, which is this project's one escaping primitive:
 * every entity it emits is valid in HTML5, and reusing it means there is no
 * second escaper to keep in step with the first. The body is inserted
 * unescaped, which is correct — it is HTML, produced by the same pipeline that
 * renders the published page and sanitised by its allow-list.
 */
function shell(input: {
  title: string
  source: string
  meta: string
  body: string
  /** The document's own language, from its frontmatter. */
  lang: string
}): string {
  return `<!doctype html>
<html lang="${escapeXml(input.lang)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${escapeXml(input.title)} — draft preview</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0 auto; max-width: 44rem; padding: 2.5rem 1.25rem 6rem;
        font-family: ui-sans-serif, system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 16px; line-height: 1.7; color: #18181b; background: #fdfdfc;
      }
      .banner {
        display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline;
        border: 1px solid #e4e4e7; padding: .75rem 1rem; margin-bottom: 2.5rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #71717a;
      }
      .banner strong { color: #18181b; font-weight: 600; }
      h1 { font-size: 1.75rem; line-height: 1.25; letter-spacing: -0.01em; margin: 0 0 1.5rem; }
      a { color: inherit; text-underline-offset: 3px; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; }
      pre { overflow-x: auto; padding: .75rem 1rem; border: 1px solid #e4e4e7; background: #f7f7f6; }
      blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 1px solid #e4e4e7; color: #52525b; }
      img, video, iframe { max-width: 100%; height: auto; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #e4e4e7; padding: .4rem .6rem; text-align: left; }
      hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2.5rem 0; }
      .prose > :first-child { margin-top: 0; }
    </style>
  </head>
  <body>
    <div class="banner">
      <strong>Draft preview</strong>
      <span>${escapeXml(input.meta)}</span>
      <span>${escapeXml(input.source)}</span>
    </div>
    <h1>${escapeXml(input.title)}</h1>
    <article class="prose">
${input.body}
    </article>
  </body>
</html>
`
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // First statement: nothing below this line runs for a signed-out request.
  await requireUser(loginReturnTo(url))

  const type = url.searchParams.get('type') ?? ''
  const slug = url.searchParams.get('slug') ?? ''

  if (!isContentType(type) || !isValidSlug(slug)) {
    return failure(
      `A preview needs a valid type (${CONTENT_TYPES.join(', ')}) and a slug.`,
      400,
    )
  }

  const relativePath = buildRelativePath(type, slug)

  try {
    // The path is built from a validated type and slug rather than taken from
    // the request, so `readDocument` is not the first thing standing between a
    // query string and the filesystem — `buildRelativePath` and its containment
    // check are.
    const doc = await readDocument(relativePath)
    if (!doc) {
      return failure(`No document at ${relativePath}.`, 404)
    }

    const { html } = await renderDocument(doc.body)

    const meta = [
      doc.type,
      doc.status,
      `updated ${isoDay(doc.updatedAt)}`,
      `published ${isoDay(doc.publishedAt)}`,
      doc.scheduledAt ? `scheduled ${isoDay(doc.scheduledAt)}` : null,
      `${doc.wordCount} words`,
      doc.seo.noindex ? 'noindex' : null,
    ]
      .filter((part): part is string => part !== null)
      .join('  ·  ')

    const page = shell({
      title: doc.title || slug,
      source: relativePath,
      meta,
      body: html,
      lang: doc.lang,
    })

    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    // A read or render failure is reported rather than swallowed: the author is
    // the only reader of this route, and "it did not render" with no trace in
    // the log is the least useful answer a preview can give.
    console.error(
      '[preview] the document could not be rendered:',
      error instanceof Error ? error.message : error,
    )
    return failure('The preview could not be rendered. See the server log.', 500)
  }
}
