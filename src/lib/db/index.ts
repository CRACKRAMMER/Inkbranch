import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool, type PoolConfig } from 'pg'
import { env, isProd } from '@/env'
import * as schema from './schema'

/**
 * Postgres connection.
 *
 * Held on `globalThis` so that Next.js hot reloading in development does not
 * open a new pool on every edit — that exhausts `max_connections` within a few
 * minutes of active work.
 */

export type Database = NodePgDatabase<typeof schema>

interface DbGlobal {
  __myblogPool?: Pool
  __myblogDb?: Database
}

const globalForDb = globalThis as unknown as DbGlobal

function createPool(connectionString = env.DATABASE_URL): Pool {
  const config: PoolConfig = {
    connectionString,
    max: env.DATABASE_POOL_MAX,
    // Leave a little headroom before the server's own timeout fires.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: !isProd,
    application_name: 'myblog',
  }

  const pool = new Pool(config)

  // A pool-level error handler is mandatory: an unhandled 'error' event from an
  // idle client crashes the process.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message)
  })

  return pool
}

export const pool: Pool = globalForDb.__myblogPool ?? createPool()
export const db: Database =
  globalForDb.__myblogDb ?? drizzle(pool, { schema, casing: 'snake_case' })

if (!isProd) {
  globalForDb.__myblogPool = pool
  globalForDb.__myblogDb = db
}

/**
 * Create an isolated client. Used by the test harness and the CLI, which must
 * not share the request-scoped pool.
 */
export function createDatabase(connectionString: string): {
  db: Database
  pool: Pool
  close: () => Promise<void>
} {
  const isolatedPool = createPool(connectionString)
  const isolatedDb = drizzle(isolatedPool, { schema, casing: 'snake_case' })
  return {
    db: isolatedDb,
    pool: isolatedPool,
    close: () => isolatedPool.end(),
  }
}

/** Verify connectivity. Used by `/admin/system` and the Docker healthcheck. */
export async function pingDatabase(): Promise<{
  ok: boolean
  latencyMs: number
  error?: string
}> {
  const started = Date.now()
  try {
    await pool.query('select 1')
    return { ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Close the pool. Call from CLI scripts so the process can exit. */
export async function closeDatabase(): Promise<void> {
  await pool.end()
}

export { schema }
