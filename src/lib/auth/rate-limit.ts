import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

/**
 * Token-bucket rate limiting, stored in Postgres.
 *
 * An in-memory limiter would reset on every deploy and would not be shared
 * across replicas — and a deploy is exactly when an attacker retries. One
 * atomic upsert per check keeps it correct under concurrency without a lock.
 */

import type { RateLimitPolicy, RateLimitResult } from './rate-limit-policy'
export { RATE_LIMITS } from './rate-limit-policy'
export type { RateLimitPolicy, RateLimitResult } from './rate-limit-policy'

/**
 * Consume tokens from the bucket identified by `key`.
 *
 * `key` should include the policy name and the subject, e.g.
 * `login:ip:1.2.3.4` or `login:user:abc`. The subject must already be hashed if
 * it is an IP address.
 */
export async function consumeRateLimit(
  key: string,
  policy: RateLimitPolicy,
): Promise<RateLimitResult> {
  const cost = policy.cost ?? 1
  const capacity = policy.capacity
  const refill = policy.refillPerSecond

  // A bucket that has been idle longer than it takes to refill from empty is
  // indistinguishable from a fresh one, so it is worth expiring.
  const ttlSeconds = Math.max(60, Math.ceil((capacity / refill) * 2))
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

  // Refill is computed from the elapsed time inside the UPDATE, so concurrent
  // requests cannot both read a stale `last_refill_at` and double-spend.
  const result = await db.execute(sql`
    insert into rate_limits (key, tokens, last_refill_at, expires_at)
    values (${key}, ${capacity - cost}, now(), ${expiresAt})
    on conflict (key) do update set
      tokens = least(
        ${capacity}::real,
        -- Negative values describe a refused request's shortage. Restore the
        -- reservation before refilling so refusals never pile up token debt.
        case when rate_limits.tokens < 0
          then rate_limits.tokens + ${cost}::real
          else rate_limits.tokens end
          + extract(epoch from (now() - rate_limits.last_refill_at))::real * ${refill}::real
      ) - ${cost}::real,
      last_refill_at = now(),
      expires_at = ${expiresAt}
    returning tokens
  `)

  const row = (result.rows[0] ?? {}) as { tokens?: number | string }
  const tokens = Number(row.tokens ?? 0)

  if (!Number.isFinite(tokens)) {
    throw new Error('The rate-limit bucket returned an invalid token balance')
  }

  if (tokens >= 0) {
    return {
      allowed: true,
      remaining: Math.floor(tokens),
      retryAfterMs: 0,
      limit: capacity,
    }
  }

  const deficit = Math.abs(tokens)
  const retryAfterMs = Math.ceil((deficit / refill) * 1000)

  return {
    allowed: false,
    remaining: 0,
    retryAfterMs,
    limit: capacity,
  }
}

/** Clear a bucket. Used after a successful login, so a legitimate user who
 * mistyped their password a few times is not left throttled. */
export async function resetRateLimit(key: string): Promise<void> {
  await db.execute(sql`delete from rate_limits where key = ${key}`)
}

/** Remove expired buckets. Run by the worker. */
export async function pruneRateLimits(): Promise<number> {
  const result = await db.execute(
    sql`delete from rate_limits where expires_at < now()`,
  )
  return result.rowCount ?? 0
}

/** `Retry-After` header value, in whole seconds, minimum 1. */
export function retryAfterSeconds(result: RateLimitResult): number {
  return Math.max(1, Math.ceil(result.retryAfterMs / 1000))
}
