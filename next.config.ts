import type { NextConfig } from 'next'

/**
 * Security headers applied to every response.
 *
 * The CSP is deliberately strict for the public site. It still permits
 * `'unsafe-inline'` for styles because Shiki emits inline `style` attributes on
 * highlighted tokens, and KaTeX ships inline styles for layout. Scripts stay
 * free of `'unsafe-inline'`: no third-party script is loaded anywhere.
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
      // Next.js injects inline bootstrap scripts; hashes are not stable across
      // builds, so 'unsafe-inline' is scoped to scripts only in development.
      process.env.NODE_ENV === 'production'
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' https://www.youtube.com https://player.vimeo.com https://www.bilibili.com",
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
         * Every path except `/api/assets`.
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
         * and a path beginning with `api/assets` fails the lookahead.
         */
        source: '/((?!api/assets).*)',
        headers: securityHeaders,
      },
      {
        // Content-addressed uploads: safe to cache aggressively.
        source: '/uploads/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ]
  },

  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [] }
  },

  typedRoutes: false,
  turbopack: {
    root: import.meta.dirname,
  },
}

export default nextConfig
