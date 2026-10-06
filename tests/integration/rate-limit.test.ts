import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { consumeRateLimit } from '@/lib/auth/rate-limit'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { rateLimits } from '@/lib/db/schema'
import { hasTestDatabase } from '../setup'

describe.skipIf(!hasTestDatabase)('durable token buckets', () => {
  const keys: string[] = []
  const makeKey = () => {
    const key = `rate-regression:${randomUUID()}`
    keys.push(key)
    return key
  }
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
  afterAll(async () => {
    if (keys.length) await db.delete(rateLimits).where(inArray(rateLimits.key, keys))
  })

  it('admits exactly the capacity when requests race for one bucket', async () => {
    const key = makeKey()
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      consumeRateLimit(key, { capacity: 5, refillPerSecond: 0.00001 })))
    expect(results.filter((result) => result.allowed)).toHaveLength(5)
  })

  it('recovers after one refill interval regardless of repeated refusals', async () => {
    const key = makeKey()
    const policy = { capacity: 1, refillPerSecond: 0.01 }
    expect((await consumeRateLimit(key, policy)).allowed).toBe(true)
    for (let count = 0; count < 20; count += 1) {
      expect((await consumeRateLimit(key, policy)).allowed).toBe(false)
    }
    // Advance the stored clock rather than waiting 100 seconds. The refused
    // traffic must not require another 20 refill intervals to clear its debt.
    await db.update(rateLimits).set({
      lastRefillAt: sql`now() - interval '101 seconds'`,
    }).where(eq(rateLimits.key, key))
    expect((await consumeRateLimit(key, policy)).allowed).toBe(true)
  })
})
