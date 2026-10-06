import { z } from 'zod'

/**
 * Environment validation.
 *
 * Parsed once at module load. In production the app refuses to start if a
 * secret is missing, too short, or left at its development default, because a
 * misconfigured session secret silently voids every other security control.
 */

const bool = (defaultValue: '0' | '1') =>
  z
    .string()
    .default(defaultValue)
    .refine((v) => ['0', '1', 'true', 'false'].includes(v.toLowerCase()), {
      message: 'Expected 0, 1, true or false',
    })
    .transform((v) => v === '1' || v.toLowerCase() === 'true')

const int = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue)

const DEV_SESSION_SECRET =
  'dev-only-secret-do-not-use-in-production-0000000000000000'

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => {
        try {
          const url = new URL(v)
          return ['postgres:', 'postgresql:'].includes(url.protocol) &&
            Boolean(url.hostname) && url.pathname.length > 1
        } catch {
          return false
        }
      },
      'DATABASE_URL must be a postgres:// or postgresql:// URL with a host and database name',
    ),
  DATABASE_POOL_MAX: int(10),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'SESSION_COOKIE_NAME may only contain word characters')
    .default('myblog_session'),
  SESSION_ABSOLUTE_TTL: int(60 * 60 * 24 * 30),
  SESSION_IDLE_TTL: int(60 * 60 * 24 * 7),
  COOKIE_SECURE: bool('0'),

  SITE_URL: z.string().url().refine((value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username &&
        !url.password && url.pathname === '/' && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'SITE_URL must be an http:// or https:// origin without credentials, path, query or fragment').default('http://localhost:3000'),
  TRUSTED_ORIGINS: z
    .string()
    .default('localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  CONTENT_DIR: z.string().default('./content'),
  CONTENT_MAX_FILES: int(5000),
  CONTENT_SYNC_ON_BOOT: bool('1'),

  /**
   * Search backend. `local` is the built-in index; `meilisearch` is the seam
   * this enum exists to make room for. Adding a value here fails compilation in
   * `src/lib/search/index.ts` until it is wired up.
   */
  SEARCH_PROVIDER: z.enum(['local']).default('local'),

  UPLOAD_DIR: z.string().default('./public/uploads'),
  UPLOAD_URL_PREFIX: z
    .string()
    .startsWith('/', 'UPLOAD_URL_PREFIX must start with /')
    .default('/uploads'),
  MAX_UPLOAD_SIZE: int(20 * 1024 * 1024),

  ANALYTICS_ENABLED: bool('1'),
  ANALYTICS_RAW_RETENTION_DAYS: int(30),

  /**
   * Permission for this deployment to commit the content directory.
   *
   * The second of the two switches git auto-commit needs, and the one no admin
   * screen can reach: the settings decide whether the *site* wants commits, this
   * decides whether the *process* may make them. Off by default, so a deployment
   * that has changed nothing runs no git process at all — and when the settings
   * ask and this refuses, the editor says so after each save rather than doing
   * nothing quietly. Nothing here ever pushes, whatever it is set to.
   */
  GIT_INTEGRATION_ENABLED: bool('0'),

  /**
   * Run the job queue's worker loop inside the server process.
   *
   * On by default, because the deployment this project ships — one container,
   * one database, one author — has nowhere else to put it. Turning it off is for
   * the two cases where that is wrong: a second app instance that should serve
   * requests without competing for the same jobs (though the queue's claims make
   * that safe, it is not free), and a process that must do nothing but serve.
   * `pnpm worker` is the other way to run one, and ignores this flag: it *is* the
   * worker.
   */
  WORKER_ENABLED: bool('1'),
  WORKER_INTERVAL_MS: int(60_000),

  /**
   * How long a finished job row is kept.
   *
   * The cadence enqueues its kinds on every interval, so this table is written
   * to on a timer whether or not anything happened — a few thousand rows a day
   * on the default settings, and a few million a year if nothing ever removed
   * them. A week is long enough to answer "did that run?" and to see a failure
   * that repeats.
   */
  JOB_RETENTION_DAYS: int(7),

  TEST_DATABASE_URL: z.string().optional(),
})

function load() {
  const parsed = schema.safeParse(process.env)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }

  return parsed.data
}

export const env = load()

/**
 * Refuse to serve with an insecure production configuration.
 *
 * ## Why this is not called from `load()`
 *
 * These are *runtime* properties, and a build is not a run. `next build` sets
 * `NODE_ENV=production` and then imports every route to collect its page data,
 * so validating here meant a build could only succeed if the machine doing the
 * building already looked like a finished deployment — a developer's
 * `.env.local` failed the secret check, and the Docker build failed on
 * `COOKIE_SECURE` and `SITE_URL`, because the variables a container is *built*
 * with are deliberately not the ones it is *deployed* with. That is backwards:
 * the values that matter are the ones the running server was given.
 *
 * So the shape of the configuration is still checked at import — a missing
 * `DATABASE_URL` or a too-short secret is a bug wherever it happens — while the
 * posture is checked from `instrumentation.ts`, which runs once when a server
 * process starts and not at all during a build.
 *
 * The failure is deliberately loud and fatal. Every check below is a control
 * that is silently void rather than visibly broken when it is misconfigured:
 * a known session secret forges any session, a cookie without `Secure` travels
 * in clear text, and an `http://` site URL produces canonical links and a
 * sitemap pointing at a scheme the site does not serve.
 */
export function assertProductionPosture(): void {
  if (env.NODE_ENV !== 'production') return

  if (env.SESSION_SECRET === DEV_SESSION_SECRET) {
    throw new Error(
      'SESSION_SECRET is still the development default. Generate one with: openssl rand -base64 48',
    )
  }
  if (!env.COOKIE_SECURE) {
    throw new Error(
      'COOKIE_SECURE must be 1 in production, otherwise session cookies are sent over plain HTTP.',
    )
  }
  if (env.SITE_URL.startsWith('http://')) {
    throw new Error('SITE_URL must use https:// in production.')
  }
}

export const isProd = env.NODE_ENV === 'production'

/** Absolute site origin without a trailing slash. */
export const siteOrigin = env.SITE_URL.replace(/\/+$/, '')
