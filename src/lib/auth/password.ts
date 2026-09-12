import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2'

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy'

/**
 * Password hashing with Argon2id.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet recommendation for
 * Argon2id: 19 MiB of memory, 2 iterations, 1 degree of parallelism. Memory cost
 * is the parameter that actually resists GPU cracking, so it is the one worth
 * spending on; ~50ms per verification is the target and these values land close
 * to it on commodity hardware.
 *
 * `@node-rs/argon2` ships prebuilt binaries, so there is no native build step
 * and no compiler in the production image.
 */

/**
 * `satisfies` rather than a type annotation: it validates the shape while
 * keeping the literal types, so `needsRehash` can compare numbers instead of
 * `number | undefined`.
 */
const PARAMS = {
  // 2 is `Algorithm.Argon2id`. The package declares `Algorithm` as an ambient
  // const enum, and `isolatedModules` forbids reading its members — so the
  // value is spelled out and asserted to the type instead.
  algorithm: 2 as Algorithm,
  memoryCost: 19_456, // KiB — 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} satisfies Options

export class PasswordError extends Error {
  readonly code = 'PASSWORD'
  constructor(message: string) {
    super(message)
    this.name = 'PasswordError'
  }
}

/**
 * Hash a password. The returned string is the standard PHC encoding and embeds
 * the salt and parameters, so no separate salt column is needed.
 */
export async function hashPassword(password: string): Promise<string> {
  assertAcceptableLength(password)
  return hash(password, PARAMS)
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row should
 * deny access, not produce a 500 that reveals the row exists.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  if (!storedHash || !password) return false
  if (password.length > MAX_PASSWORD_LENGTH) return false

  try {
    return await verify(storedHash, password, PARAMS)
  } catch {
    return false
  }
}

/**
 * True when the hash was produced with parameters weaker than the current
 * policy. Called after a successful login so the stored hash can be upgraded
 * transparently while the plaintext is briefly available.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = parsePhc(storedHash)
  if (!parsed) return true
  if (parsed.algorithm !== 'argon2id') return true
  return (
    (parsed.memoryCost ?? 0) < PARAMS.memoryCost ||
    (parsed.timeCost ?? 0) < PARAMS.timeCost ||
    (parsed.parallelism ?? 0) !== PARAMS.parallelism
  )
}

interface PhcParams {
  algorithm: string
  memoryCost?: number
  timeCost?: number
  parallelism?: number
}

/** Parse `$argon2id$v=19$m=19456,t=2,p=1$salt$hash`. */
function parsePhc(encoded: string): PhcParams | null {
  const parts = encoded.split('$')
  if (parts.length < 4) return null

  const algorithm = parts[1]
  if (!algorithm) return null

  const params: PhcParams = { algorithm }
  const paramSection = parts[3]
  if (!paramSection) return params

  for (const pair of paramSection.split(',')) {
    const [key, rawValue] = pair.split('=')
    const value = Number(rawValue)
    if (!key || !Number.isFinite(value)) continue
    if (key === 'm') params.memoryCost = value
    if (key === 't') params.timeCost = value
    if (key === 'p') params.parallelism = value
  }

  return params
}

function assertAcceptableLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    )
  }
}
