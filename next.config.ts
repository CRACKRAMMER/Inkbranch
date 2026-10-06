import type { NextConfig } from 'next'

import { ALLOWED_EMBED_ORIGINS, ALLOWED_MEDIA_ORIGINS } from './src/lib/security/embed-origins'

/**
 * Security headers applied to every response.
 *
 * ## What the CSP does, and what it does not
 *
 * `style-src` needs `'unsafe-inline'` because Shiki writes inline `style`
 * attributes on highlighted tokens and KaTeX ships inline styles for layout.
 * Neither is expressible as a class, so that one is not a compromise — it is
 * the only way to serve those two.
 *
 * `script-src` needs it as well, and *that* is a compromise. Next's App Router
 * puts the RSC payload in inline `<script>` tags — 21 of them on the home page,
 * none carrying a nonce — and their contents differ per page and per render, so
 * there is no stable hash to allow in their place. `'unsafe-inline'` is
 * therefore present in production as well as development. The ternary below
 * only adds `'unsafe-eval'`, which the dev server's HMR runtime compiles with
 * and production does not.
 *
 * So this CSP is not the thing that stops an injected `<script>`, and a comment
 * claiming otherwise would be worse than no comment. What stops it is
 * `rehype-sanitize` in the Markdown pipeline and the magic-byte check on
 * uploads. The CSP is the layer behind those, and it still does real work:
 * `script-src 'self'` keeps every third-party origin out, `object-src 'none'`
 * and `base-uri 'self'` close two classic bypasses, and `frame-ancestors
 * 'self'` blocks clickjacking.
 *
 * Dropping `'unsafe-inline'` from `script-src` means generating a nonce per
 * request in `src/proxy.ts` and letting Next stamp it onto the scripts it
 * renders — and then the theme bootstrap, which is written inline, has to read
 * the nonce rather than be one. Worth doing, not done.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // `'unsafe-inline'` is in both branches — see the note above for why it
      // has to be. What the mode actually decides is `'unsafe-eval'`, which the
      // dev server's HMR runtime needs and production must not have.
      process.env.NODE_ENV === 'production'
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // `data:` is not only for the icons: it is what the blur placeholder is
      // painted from. The renderer writes the asset row's data URI into a
      // custom property and `globals.css` makes it a `background-image`, which
      // this directive governs — so dropping `data:` here would take the
      // placeholder off every image on the site, silently.
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      // Both directives are derived from the allow-list in
      // `src/lib/security/embed-origins.ts` rather than written out here. The
      // renderer consults the same list to decide which `<iframe>` elements
      // survive the Markdown pipeline, and the two answers have to match: an
      // origin this header permits but the renderer strips buys nothing, and
      // one the renderer keeps but this header refuses is a frame the reader
      // sees as an empty rectangle. They were written twice once, and drifted
      // by seven origins — `tests/unit/embed-origins.test.ts` is what makes
      // that a failing test now instead of a blank space on a page.
      `frame-src 'self' ${ALLOWED_EMBED_ORIGINS.map((origin) => `https://${origin}`).join(' ')}`,
      `media-src 'self' ${ALLOWED_MEDIA_ORIGINS.map((origin) => `https://${origin}`).join(' ')}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /*
   * `standalone` writes a server bundle with only the modules it actually
   * reached, so the runtime image does not carry `node_modules`. It is set
   * unconditionally rather than behind an env check: it changes the shape of
   * `.next` and nothing else, `next start` still works on the result, and a
   * config that builds differently depending on where it runs is a config
   * whose Docker build is not the build that was tested.
   *
   * `next start` does warn that it "does not work" with this output and points
   * at `node .next/standalone/server.js`. The warning is worth reading as
   * advisory: it is the same server either way, and `next start` serves this
   * build correctly — verified, 200 with the page and its static assets. What
   * it does *not* do is relax the app's own production posture, so on a machine
   * whose `.env.local` still holds the development `SESSION_SECRET` it boots
   * straight into `assertProductionPosture`'s refusal and answers 500 on every
   * route. That failure looks like a broken build and is not one; it is the app
   * declining to run with a published secret. `scripts/serve-standalone.ts`
   * exists to remove that ambiguity locally.
   *
   * The consequences that are real: `public/` and `.next/static/` are *not*
   * copied into `.next/standalone`, so the Dockerfile copies them by hand; and
   * `server.js` calls `process.chdir(__dirname)`, so `.env.local` is not read
   * from the project root and a relative path in the environment resolves under
   * `.next/standalone` instead.
   */
  output: 'standalone',

  experimental: {
    // Content files are read from disk at request time; keep the server bundle
    // from trying to trace the whole content tree into the build output.
    serverSourceMaps: false,

    /*
     * The ceiling on a server action's request body, raised from the 1 MB default.
     *
     * Both of the application's own limits are above that default — an asset
     * upload is capped at `MAX_UPLOAD_SIZE` (20 MB) and an import archive at
     * `IMPORT_LIMITS.maxArchiveBytes` (32 MB) — so without this the framework
     * refused first and the operator saw a body-limit error from Next instead of
     * the message the code had already written for them. A limit nobody chose,
     * enforced somewhere the error does not explain.
     *
     * 40 MB is the larger of the two plus room for multipart framing, which is
     * charged against this limit too (boundaries, part headers, field metadata —
     * the framework's own guidance is 10–20 KB for a typical upload). It is a
     * constant and the other two are configurable, so raising `MAX_UPLOAD_SIZE`
     * above roughly 40 MB needs this raised with it; the comment is here so that
     * the dependency is findable from either end.
     *
     * Not unbounded, deliberately: the body is buffered in memory before the
     * action runs, so this number is also the amount of memory one request can
     * commit the server to.
     *
     * `experimental`, not top level. The option is documented only there, and
     * `NextConfig` rejects it anywhere else — which is how this was caught.
     */
    serverActions: {
      bodySizeLimit: '40mb',
    },
  },

  // `sharp` is used by the image optimiser and by our own asset pipeline.
  serverExternalPackages: ['@node-rs/argon2', 'sharp'],

  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [360, 480, 640, 828, 1080, 1200, 1600, 1920],
    imageSizes: [16, 32, 64, 96, 128, 256, 384],
    // Uploads are served from our own origin only. Remote patterns are added
    // from site settings at runtime if the owner configures a CDN.
    remotePatterns: [],
  },

  async headers() {
    return [
      {
        /*
         * Every path except uploaded files, including their `/uploads` alias.
         *
         * Config headers are applied to the response after the route has run,
         * so a matching rule here silently replaces a header the route set
         * itself. `/api/assets` serves user-uploaded files — including SVG,
         * which is a script execution context when a browser navigates to it
         * directly — and its handler sets `default-src 'none'; sandbox` for
         * exactly that case. Letting this rule overwrite that CSP would leave
         * uploaded SVG protected by nothing but its sniffed content type.
         *
         * The negative lookahead is the documented way to express "all paths
         * but this one": the outer group is matched as a regular expression,
         * and either upload prefix fails the lookahead.
         */
        source: '/((?!api/assets(?:/|$)|uploads(?:/|$)).*)',
        headers: securityHeaders,
      },
    ]
  },

  async rewrites() {
    // Run before public-file lookup so the legacy/default upload URL gets the
    // same symlink jail, private-directory checks and SVG sandbox as the API.
    return {
      beforeFiles: [{ source: '/uploads/:path*', destination: '/api/assets/:path*' }],
      afterFiles: [],
      fallback: [],
    }
  },

  async redirects() {
    return [
      /*
       * `/tag/linux` → `/tags/linux`, and `/tag` → `/tags`. §46 writes the
       * route in the singular and this site spells it in the plural, so the
       * form the spec names is a shape of URL people will have written down.
       * A redirect is how both are true: the alias resolves, and there is
       * still one canonical address per topic for a crawler to settle on.
       *
       * Here rather than in the redirects table, which matches whole paths
       * exactly — a row per tag is a row per tag, and one that no longer
       * exists is a rule that outlives the topic it was written for. A
       * dynamic segment is a rule about a URL shape, which is a different
       * thing and belongs where the routes are declared.
       *
       * The consequence of the ordering is worth knowing: config redirects
       * run before routing, so an admin-created redirect on `/tag/anything`
       * would never fire. Nothing warns about that, hence this note.
       *
       * `permanent` gives 308. The alias is not a temporary state of affairs,
       * and a search engine that has seen `/tag/linux` should move its
       * entry rather than keep both.
       */
      { source: '/tag', destination: '/tags', permanent: true },
      { source: '/tag/:tag', destination: '/tags/:tag', permanent: true },
    ]
  },

  typedRoutes: false,
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
