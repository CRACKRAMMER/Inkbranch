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
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// connection string',
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

  SITE_URL: z.string().url().default('http://localhost:3000'),
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

  GIT_INTEGRATION_ENABLED: bool('0'),

  WORKER_INTERVAL_MS: int(60_000),

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

  const env = parsed.data

  if (env.NODE_ENV === 'production') {
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

  return env
}

export const env = load()

export const isProd = env.NODE_ENV === 'production'
export const isDev = env.NODE_ENV === 'development'
export const isTest = env.NODE_ENV === 'test'

/** Absolute site origin without a trailing slash. */
export const siteOrigin = env.SITE_URL.replace(/\/+$/, '')
