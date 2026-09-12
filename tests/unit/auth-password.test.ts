import { describe, expect, it } from 'vitest'

import { hashPassword, verifyPassword } from '@/lib/auth/password'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordStrength,
} from '@/lib/auth/password-policy'

/**
 * Password rules, and the boundary between where they live and where they are
 * enforced.
 *
 * ## Why this file has a module boundary in it
 *
 * The rules and the hasher used to be one file. They were split when the
 * change-password form needed two of the rules in the browser: `password.ts`
 * imports `@node-rs/argon2`, and importing the length bounds from there would
 * have put a native module in the client bundle.
 *
 * A split like that introduces exactly one new failure — the number the form
 * checks against drifting from the number the hasher enforces, so a password
 * the form accepts still throws on the server. The last two tests here are the
 * ones that would catch it, and they are the reason this file is not only about
 * scores.
 *
 * ## What is *not* claimed
 *
 * `passwordStrength` is a nudge, not a gate: its doc says so, and these tests
 * do not treat its scores as security. The only thing asserted about them is
 * the one property a person relies on — that a password short enough to be
 * refused is never labelled strong.
 */

/** Enough variety to move the score around without being a word list. */
const SAMPLES = [
  '',
  'a',
  'short1!',
  'alllowercasebutlong',
  'AllLowercaseButLong',
  'correct-horse-battery-staple',
  'aMuchLongerPassphraseWithNumbers12345',
  '在一个有中文的世界里-password-1234',
  'x'.repeat(MAX_PASSWORD_LENGTH),
]

describe('passwordStrength', () => {
  it('never calls a password below the minimum strong', () => {
    // The length minimum is what actually gates access, and the meter is what a
    // person reads while choosing. A meter that said "Strong" about a password
    // the server will refuse would be worse than no meter at all.
    for (const sample of SAMPLES) {
      if (sample.length >= MIN_PASSWORD_LENGTH) continue
      expect(passwordStrength(sample).label).not.toBe('Strong')
      expect(passwordStrength(sample).label).not.toBe('Very strong')
    }
  })

  it('keeps the score inside its range, with the label it names', () => {
    const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong']

    for (const sample of SAMPLES) {
      const { score, label } = passwordStrength(sample)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(4)
      expect(label).toBe(labels[score])
    }
  })

  it('does not lower the score when a password gets longer', () => {
    // Appending cannot make a password weaker, and a meter that flickered
    // downwards as someone kept typing would be telling them the opposite of
    // what is true.
    for (const sample of SAMPLES) {
      const before = passwordStrength(sample).score
      for (const suffix of ['a', '7', '!', 'Z']) {
        expect(passwordStrength(sample + suffix).score).toBeGreaterThanOrEqual(before)
      }
    }
  })
})

describe('the rules and the hasher', () => {
  it('hashes the shortest password the form allows', async () => {
    const shortest = 'a'.repeat(MIN_PASSWORD_LENGTH)
    const hash = await hashPassword(shortest)
    expect(await verifyPassword(hash, shortest)).toBe(true)
  })

  it('refuses the lengths the form refuses', async () => {
    // The two lengths below are read by the form (which shows a message) and by
    // `assertAcceptableLength` (which throws). Both read them from
    // `password-policy.ts`, and this is the assertion that fails if that stops
    // being true.
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(
      /at least/,
    )
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(
      /at most/,
    )
  })
})
