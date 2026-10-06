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
