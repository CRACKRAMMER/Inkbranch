import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { auditLogs, siteSettings } from '@/lib/db/schema'
import { getSettings, updateSettings } from '@/lib/settings'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  isLocaleTag,
  isSettingsKey,
  isTimeZone,
  settingsPatchSchema,
  settingsSchema,
} from '@/lib/settings/schema'
import { hasTestDatabase } from '../setup'

/**
 * Settings.
 *
 * The schema is the contract between the database, the admin form and every
 * component that reads a setting, so most of this is about the shape rather
 * than about storage: which keys exist, what an unset key falls back to, and
 * what a patch is allowed to say. Those run everywhere. The round-trip through
 * `site_settings` needs a database and skips without one.
 */

describe('SETTINGS_DEFAULTS', () => {
  it('covers exactly the keys the schema declares', () => {
    expect(Object.keys(SETTINGS_DEFAULTS).sort()).toEqual([...SETTINGS_KEYS].sort())
  })

  it('is itself valid, so an unset site has working values', () => {
    const parsed = settingsSchema.safeParse(SETTINGS_DEFAULTS)
    expect(parsed.success).toBe(true)
  })
})

describe('isSettingsKey', () => {
  it('accepts every declared key', () => {
    for (const key of SETTINGS_KEYS) {
      expect(isSettingsKey(key)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    // The point of the registry: a key outside it would be stored and then
    // never read back, because every reader goes through the same schema.
    expect(isSettingsKey('siteName ')).toBe(false)
    expect(isSettingsKey('site_name')).toBe(false)
    expect(isSettingsKey('nope')).toBe(false)
    expect(isSettingsKey('')).toBe(false)
  })
})

describe('settingsPatchSchema', () => {
  it('invents no keys for an empty patch', () => {
    // `.partial()` on a field carrying `.default()` still fills the default in,
    // which would make `updateSettings({})` write every setting in the table.
    // The shape therefore has no defaults, and this is the test that says so.
    expect(settingsPatchSchema.parse({})).toEqual({})
  })

  it('keeps only the keys the caller sent', () => {
    const parsed = settingsPatchSchema.parse({ siteName: 'Renamed' })
    expect(Object.keys(parsed)).toEqual(['siteName'])
  })

  it('rejects an unknown key instead of dropping it', () => {
    const parsed = settingsPatchSchema.safeParse({ siteNam: 'Typo' })
    expect(parsed.success).toBe(false)
  })

  it('validates the keys it does know', () => {
    expect(settingsPatchSchema.safeParse({ rssItemLimit: 'many' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ rssItemLimit: 0 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ rssItemLimit: 30 }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ siteName: '' }).success).toBe(false)
  })

  it('accepts an explicit null for a nullable field', () => {
    const parsed = settingsPatchSchema.parse({ avatarUrl: null })
    expect(parsed.avatarUrl).toBeNull()
  })
})

describe('settingsSchema fields', () => {
  const field = (key: keyof typeof settingsSchema.shape) => settingsSchema.shape[key]

  it('caps text at the width of its column', () => {
    expect(field('siteName').safeParse('x'.repeat(120)).success).toBe(true)
    expect(field('siteName').safeParse('x'.repeat(121)).success).toBe(false)
    expect(field('tagline').safeParse('x'.repeat(201)).success).toBe(false)
    expect(field('gitCommitTemplate').safeParse('x'.repeat(201)).success).toBe(false)
  })

  it('refuses a title template that would drop the page title', () => {
    expect(field('seoTitleTemplate').safeParse('%s | My Blog').success).toBe(true)
    expect(field('seoTitleTemplate').safeParse('%s').success).toBe(true)
    expect(field('seoTitleTemplate').safeParse('My Blog').success).toBe(false)
  })

  it('refuses a URL that is not a path or an http(s) URL', () => {
    expect(field('avatarUrl').safeParse(null).success).toBe(true)
    expect(field('avatarUrl').safeParse('/uploads/me.png').success).toBe(true)
    expect(field('avatarUrl').safeParse('https://example.com/me.png').success).toBe(true)
    expect(field('avatarUrl').safeParse('javascript:alert(1)').success).toBe(false)
    expect(field('avatarUrl').safeParse('//evil.example/me.png').success).toBe(false)
    expect(field('avatarUrl').safeParse('uploads/me.png').success).toBe(false)
  })

  it('bounds the numeric settings', () => {
    expect(field('rssItemLimit').safeParse(1).success).toBe(true)
    expect(field('rssItemLimit').safeParse(201).success).toBe(false)
    expect(field('rssItemLimit').safeParse(2.5).success).toBe(false)
    expect(field('revisionsMaxPerContent').safeParse(0).success).toBe(false)
    expect(field('revisionsMaxPerContent').safeParse(1001).success).toBe(false)
  })

  it('accepts a mailto on the contact list but not as an avatar', () => {
    const contact = field('aboutContact')
    expect(contact.safeParse([{ label: 'GitHub', href: 'https://github.com/x' }]).success).toBe(true)
    expect(contact.safeParse([{ label: 'Mail', href: 'mailto:x@example.com' }]).success).toBe(true)
    expect(contact.safeParse([{ label: 'Bad', href: 'javascript:alert(1)' }]).success).toBe(false)
    // The address is followed by a mail client, so a line break in it is an
    // extra header rather than part of the address.
    expect(
      contact.safeParse([
        { label: 'Inject', href: 'mailto:x@example.com?body=%0d%0aBcc:y@example.com' },
      ]).success,
    ).toBe(false)

    // An avatar is fetched, not clicked, so mailto has no meaning there.
    expect(field('avatarUrl').safeParse('mailto:x@example.com').success).toBe(false)
  })

  it('keeps custom keys nameable and bounded', () => {
    const custom = field('custom')
    expect(custom.safeParse({ accent: '#fff' }).success).toBe(true)
    expect(custom.safeParse({ '1leading-digit': true }).success).toBe(false)
    expect(custom.safeParse({ 'has space': true }).success).toBe(false)

    const tooMany = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`key${index}`, index]),
    )
    expect(custom.safeParse(tooMany).success).toBe(false)
  })
})

describe('locale and time zone checks', () => {
  it('accepts the tags and zones a site actually uses', () => {
    expect(isLocaleTag('zh-CN')).toBe(true)
    expect(isLocaleTag('en')).toBe(true)
    expect(isTimeZone('Asia/Shanghai')).toBe(true)
    expect(isTimeZone('UTC')).toBe(true)
  })

  it('rejects what the runtime would throw on', () => {
    expect(isLocaleTag('not a locale')).toBe(false)
    expect(isLocaleTag('')).toBe(false)
    expect(isTimeZone('Mars/Phobos')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })
})

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('site_settings storage', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  const clear = () =>
    db.delete(siteSettings).where(eq(siteSettings.id, 'default'))

  it('returns defaults for a site with no row', async () => {
    await clear()
    expect(await getSettings()).toEqual(SETTINGS_DEFAULTS)
  })

  it('returns defaults for a site with an untouched row', async () => {
    await clear()
    await db.insert(siteSettings).values({ id: 'default' })
    expect(await getSettings()).toEqual(SETTINGS_DEFAULTS)
  })

  it('writes only the keys present', async () => {
    await clear()
    await updateSettings({ siteName: 'Renamed' })

    const [row] = await db.select().from(siteSettings)
    expect(row?.siteName).toBe('Renamed')
    expect(row?.authorName).toBe(SETTINGS_DEFAULTS.authorName)
    expect(row?.rssItemLimit).toBe(SETTINGS_DEFAULTS.rssItemLimit)
  })

  it('returns the merged result and reads it back', async () => {
    await clear()
    const written = await updateSettings({ tagline: 'Notes on things' })
    expect(written.tagline).toBe('Notes on things')
    expect(written.siteName).toBe(SETTINGS_DEFAULTS.siteName)
    expect((await getSettings()).tagline).toBe('Notes on things')
  })

  it('merges custom keys rather than replacing the blob', async () => {
    await clear()
    await updateSettings({ custom: { first: 1 } })
    const merged = await updateSettings({ custom: { second: 2 } })
    expect(merged.custom).toEqual({ first: 1, second: 2 })
  })

  it('leaves other keys alone when one is set', async () => {
    await clear()
    await updateSettings({ siteName: 'One', tagline: 'Two' })
    await updateSettings({ tagline: 'Three' })

    const [row] = await db.select().from(siteSettings)
    expect(row?.siteName).toBe('One')
    expect(row?.tagline).toBe('Three')
  })

  it('refuses a value that fails its own field', async () => {
    await clear()
    await expect(
      updateSettings({ rssItemLimit: 0 }),
    ).rejects.toMatchObject({ code: 'SETTINGS', reason: 'invalid_patch' })
  })

  it('refuses a patch with an unknown key', async () => {
    await clear()
    await expect(
      updateSettings({ nope: true } as never),
    ).rejects.toMatchObject({ code: 'SETTINGS', reason: 'invalid_patch' })
  })

  it('records the change in the audit log', async () => {
    await clear()

    // The row written by this call is identified by the ids that were there
    // before it, rather than by clearing the table: the suite for another
    // module is writing audit rows into the same database as this one runs.
    const before = new Set(
      (
        await db
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(eq(auditLogs.action, 'settings.update'))
      ).map((row) => row.id),
    )

    await updateSettings({ siteName: 'Audited' })

    const written = (
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'settings.update'))
    ).filter((row) => !before.has(row.id))

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      targetType: 'settings',
      targetId: 'default',
      userId: null,
      outcome: 'ok',
    })
    expect(written[0]?.meta).toEqual({ keys: ['siteName'] })
  })
})
