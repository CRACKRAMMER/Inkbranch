import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque token generation and comparison.
 *
 * Session tokens and CSRF tokens are random values that are never stored in
 * plaintext. The database holds a SHA-256 of each, so a leaked database dump
 * does not hand over live sessions — the same reasoning as password hashing,
 * with a fast hash because the input already has full entropy.
 */

/** Bytes of entropy in a session token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32

/** URL-safe base64 without padding: no `+`, `/`, or `=` to escape. */
export function generateToken(bytes = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Hash a token for storage.
 *
 * SHA-256 is correct here and not a weakening: the input is 256 bits of CSPRNG
 * output, so there is nothing to brute-force and no need for a slow KDF.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Constant-time comparison for two hex digests.
 * Length is checked first because `timingSafeEqual` throws on a mismatch.
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

/**
 * Hash a client IP for storage.
 *
 * Analytics and audit rows must not carry a raw IP. Keying the hash with
 * `SESSION_SECRET` means the digest is not reversible with a rainbow table over
 * the (small) IPv4 space.
 */
export function hashIp(ip: string, secret: string): string {
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 64)
}

/**
 * Derive a per-day visitor identifier.
 *
 * Including the date means the same visitor gets an unrelated hash tomorrow, so
 * unique counts work within a day and cannot be linked across days. This is the
 * privacy boundary that makes the analytics aggregate-only in practice, not just
 * in the schema.
 */
export function visitorHash(
  ip: string,
  userAgent: string,
  day: string,
  secret: string,
): string {
  return createHash('sha256')
    .update(`${secret}:${day}:${ip}:${userAgent}`)
    .digest('hex')
    .slice(0, 32)
}
