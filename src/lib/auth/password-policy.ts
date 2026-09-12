/**
 * The password rules, separate from the hasher.
 *
 * ## Why this module exists on its own
 *
 * `password.ts` imports `@node-rs/argon2`, a native module, and anything that
 * imports it can only run on the server. Two of the rules here are needed in
 * the browser: the length bounds, so the change-password form can refuse a
 * short password before a round trip, and `passwordStrength`, which is drawn
 * while the operator types. Importing them from `password.ts` would pull a
 * native binding into the client bundle, so they live in a module that imports
 * nothing at all — the same reason `src/lib/admin/result.ts` has no imports.
 *
 * `password.ts` imports these and adds the hashing. Adding a rule that the
 * hasher enforces means adding it here, where the form can see it too.
 */

/** Reject absurd passwords before hashing; Argon2 cost scales with length. */
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024

/**
 * Rough strength score, 0–4, based on length and character variety.
 *
 * Deliberately simple and local: no dictionary, no network call, no claim to be
 * a real estimator. It exists to nudge a single administrator, not to gate
 * access — the length minimum does that.
 */
export function passwordStrength(password: string): {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  suggestions: string[]
} {
  const suggestions: string[] = []
  if (password.length < MIN_PASSWORD_LENGTH) {
    suggestions.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`)
  }

  const hasLower = /[a-z]/.test(password)
  const hasUpper = /[A-Z]/.test(password)
  const hasDigit = /\d/.test(password)
  const hasSymbol = /[^\w\s]/.test(password)
  const hasNonAscii = /[^\x20-\x7e]/.test(password)

  const variety = [hasLower, hasUpper, hasDigit, hasSymbol || hasNonAscii].filter(
    Boolean,
  ).length

  // Length dominates; variety adds a smaller bonus, mirroring the fact that a
  // long passphrase beats a short string with symbols.
  let score = 0
  if (password.length >= MIN_PASSWORD_LENGTH) score += 1
  if (password.length >= 16) score += 1
  if (password.length >= 24) score += 1
  if (variety >= 3) score += 1
  if (variety <= 1) score -= 1

  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4

  if (clamped < 3) {
    if (!hasUpper && !hasNonAscii) suggestions.push('Mix in uppercase or non-Latin characters')
    if (!hasDigit) suggestions.push('Add a number')
    if (variety < 3) suggestions.push('Combine letters with numbers or symbols')
  }

  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const
  return { score: clamped, label: labels[clamped], suggestions }
}
