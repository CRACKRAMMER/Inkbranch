import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

/**
 * Token-bucket rate limiting, stored in Postgres.
 *
 * An in-memory limiter would reset on every deploy and would not be shared
 * across replicas — and a deploy is exactly when an attacker retries. One
 * atomic upsert per check keeps it correct under concurrency without a lock.
 */

export interface RateLimitPolicy {
  /** Bucket size: the number of requests allowed in a burst. */
  capacity: number
  /** Tokens replenished per second. */
  refillPerSecond: number
  /** Tokens consumed per request. */
  cost?: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Whole tokens left after this request; never negative. */
  remaining: number
  /** Milliseconds until at least one token is available. */
  retryAfterMs: number
  limit: number
}

/**
 * Named policies, so limits are reviewable in one place.
 *
 * An entry here is a claim that something calls it: a policy is added with its
 * consumer rather than ahead of one, because an unconsumed policy is worse than
 * an absent one — the next reader of this table counts that route as covered.
 *
 * There is deliberately no entry for the analytics beacon, and that is a
 * decision rather than an oversight: a bucket needs a subject, and this is the
 * one endpoint in the product whose contract is that nothing about the reader is
 * read. What is left for a subject is the reader's address, which that route
 * refuses to look at, or a value the client mints, which a client can throw away
 * — so a policy here would be a promise the route cannot keep. The beacon's own
 * bound is `ANALYTICS_RAW_RETENTION_DAYS`; see `src/app/api/analytics/route.ts`.
 */
export const RATE_LIMITS = {
  /** Password guessing. Tight, and keyed on both IP and account. */
  login: { capacity: 5, refillPerSecond: 5 / 900, cost: 1 },
  /** Account-level lockout, in case the attacker rotates IPs. */
  loginAccount: { capacity: 10, refillPerSecond: 10 / 3600, cost: 1 },
  /** Uploads are expensive (sharp re-encodes); cap them. */
  upload: { capacity: 30, refillPerSecond: 30 / 60, cost: 1 },
  /** Search hits the in-process index; keep it generous but bounded. */
  search: { capacity: 60, refillPerSecond: 1, cost: 1 },
  /** Content import can be a large ZIP; rare and deliberate. */
  import: { capacity: 5, refillPerSecond: 5 / 3600, cost: 1 },
  /** Password changes and other sensitive account operations. */
  sensitiveAction: { capacity: 10, refillPerSecond: 10 / 3600, cost: 1 },
} as const satisfies Record<string, RateLimitPolicy>

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
        rate_limits.tokens
          + extract(epoch from (now() - rate_limits.last_refill_at))::real * ${refill}::real
      ) - ${cost}::real,
      last_refill_at = now(),
      expires_at = ${expiresAt}
    returning tokens
  `)

  const row = (result.rows[0] ?? {}) as { tokens?: number | string }
  const tokens = Number(row.tokens ?? 0)

  if (!Number.isFinite(tokens)) {
    // A malformed row must not silently block the whole application.
    return { allowed: true, remaining: capacity, retryAfterMs: 0, limit: capacity }
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
