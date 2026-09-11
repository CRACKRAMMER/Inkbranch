import { z } from 'zod'
import { DEFAULT_COMMIT_TEMPLATE } from '@/lib/git/message'
import { internalOrExternalUrlSchema, linkHrefSchema } from '@/lib/security/urls'

/**
 * Site settings shape.
 *
 * Mirrors the typed columns of `site_settings` one for one. Every length cap
 * below is the width of the column it writes to, not a guess: a setting the
 * schema accepts but the column rejects is a 500 at write time, and a setting
 * the column accepts but the schema rejects is a read that throws on data the
 * database considers perfectly valid. The two have to agree.
 *
 * Text columns have no width in Postgres, so their caps are judgement calls and
 * are written generously — they exist to stop a paste accident, not to model a
 * product decision.
 */

/* -------------------------------------------------------------------------- */
/*  Field-level checks                                                         */
/* -------------------------------------------------------------------------- */

/**
 * True when `value` is a well-formed BCP-47 language tag.
 *
 * `Intl.getCanonicalLocales` is the authority rather than a regular expression
 * because the locale is handed to `Intl` and to `<html lang>`; if it would
 * throw there, it is wrong here.
 */
export function isLocaleTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length > 0
  } catch {
    // Throws on a malformed tag — which is the answer, not an error to report.
    return false
  }
}

/** True when `value` names a time zone the runtime recognises. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const localeSchema = z
  .string()
  .trim()
  .max(12)
  .refine(isLocaleTag, 'Not a valid language tag, e.g. zh-CN or en')

const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine(isTimeZone, 'Not a time zone the runtime recognises, e.g. Asia/Shanghai')

/**
 * The SEO title template must keep `%s`.
 *
 * It is the only placeholder that puts the page title into `<title>`. A
 * template without it drops the title from every page in the site at once, and
 * the mistake is invisible until something indexes the site.
 */
const seoTitleTemplateSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => value.includes('%s'),
    'The title template must contain %s, which is replaced by the page title',
  )

/** About-page entries are free text shown on a public page, so they are length-capped. */
const aboutCurrentlySchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(40),
      value: z.string().trim().max(200),
    }),
  )
  .max(20, 'At most 20 entries')

const aboutStackSchema = z
  .array(
    z.object({
      group: z.string().trim().min(1).max(80),
      items: z.array(z.string().trim().min(1).max(60)).max(40, 'At most 40 items'),
    }),
  )
  .max(20, 'At most 20 groups')

const aboutContactSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(40),
      // A contact list that cannot express an email address is not a contact
      // list, so this is the one settings field allowed to hold a mailto.
      href: linkHrefSchema,
    }),
  )
  .max(20, 'At most 20 links')

/**
 * Custom settings live in one jsonb column, so nothing but this refinement
 * bounds them.
 *
 * Reserved for keys that have no column, and that is the risk: a custom key
 * that duplicates a typed one (`siteName`) would sit in the blob forever, read
 * by nobody, while the typed column holds the value that is actually rendered.
 */
const CUSTOM_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,59}$/

const customSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Object.keys(value).length <= 50,
    'At most 50 custom settings',
  )
  .refine(
    (value) => Object.keys(value).every((key) => CUSTOM_KEY.test(key)),
    'Custom keys start with a letter and contain only letters, digits, dot, dash and underscore',
  )

/* -------------------------------------------------------------------------- */
/*  The schema                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * No field carries `.default()`.
 *
 * Defaults live in `SETTINGS_DEFAULTS` below instead, because the patch schema
 * is this shape made partial — and `.partial()` on a field with a default still
 * fills that default in when the key is absent. `updateSettings({})` would then
 * write every setting in the table, which is the opposite of a patch.
 */
export const settingsSchema = z.object({
  // Identity
  siteName: z.string().trim().min(1).max(120),
  siteDescription: z.string().trim().max(2000),
  authorName: z.string().trim().max(120),
  tagline: z.string().trim().max(200),
  avatarUrl: internalOrExternalUrlSchema.nullable(),
  locale: localeSchema,
  timezone: timeZoneSchema,

  // SEO
  seoTitleTemplate: seoTitleTemplateSchema,
  seoDefaultDescription: z.string().trim().max(500),
  twitterHandle: z.string().trim().max(80).nullable(),
  googleVerification: z.string().trim().max(200).nullable(),

  // Features
  analyticsEnabled: z.boolean(),
  searchEnabled: z.boolean(),
  graphEnabled: z.boolean(),
  commentsEnabled: z.boolean(),
  rssEnabled: z.boolean(),
  rssItemLimit: z.number().int().min(1).max(200),

  // Git integration
  gitEnabled: z.boolean(),
  gitAutoCommit: z.boolean(),
  gitCommitTemplate: z.string().trim().max(200),

  // Revisions
  revisionsEnabled: z.boolean(),
  revisionsMaxPerContent: z.number().int().min(1).max(1000),

  // About page
  aboutProfile: z.string().trim().max(20000),
  aboutFocus: z.array(z.string().trim().min(1).max(60)).max(30, 'At most 30 focus areas'),
  aboutCurrently: aboutCurrentlySchema,
  aboutStack: aboutStackSchema,
  aboutContact: aboutContactSchema,

  /** Extras with no column of their own. */
  custom: customSchema,
})

export type Settings = z.infer<typeof settingsSchema>
export type SettingsKey = keyof Settings

/**
 * What an unset site renders.
 *
 * Typed as `Settings` so the compiler refuses a shape that has drifted from
 * `settingsSchema`: adding a field without a default is a build failure here
 * rather than a `undefined` in a component. The values match the column
 * defaults in `src/lib/db/schema.ts`, so a seeded row and an absent row behave
 * identically — which matters because the row is created by the seed script and
 * a site that has never been seeded still has to render.
 */
export const SETTINGS_DEFAULTS: Settings = {
  siteName: 'My Blog',
  siteDescription: 'Personal knowledge system and publishing platform.',
  authorName: '',
  tagline: '',
  avatarUrl: null,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',

  seoTitleTemplate: '%s',
  seoDefaultDescription: '',
  twitterHandle: null,
  googleVerification: null,

  analyticsEnabled: true,
  searchEnabled: true,
  graphEnabled: true,
  commentsEnabled: false,
  rssEnabled: true,
  rssItemLimit: 30,

  gitEnabled: false,
  gitAutoCommit: false,
  // Shared with the module that commits rather than repeated here: the default
  // an operator never edited and the fallback an unreadable template gets have
  // to be the same sentence.
  gitCommitTemplate: DEFAULT_COMMIT_TEMPLATE,

  revisionsEnabled: true,
  revisionsMaxPerContent: 50,

  aboutProfile: '',
  aboutFocus: [],
  aboutCurrently: [],
  aboutStack: [],
  aboutContact: [],

  custom: {},
}

/**
 * Every writable key.
 *
 * Derived from the schema rather than written out by hand, so a field added to
 * the shape is writable immediately and a field removed from it stops being
 * writable. A key that is not in here cannot be written: it would be a row of
 * settings that nothing reads back, since every reader goes through the same
 * schema.
 */
export const SETTINGS_KEYS: readonly SettingsKey[] = Object.keys(
  settingsSchema.shape,
) as SettingsKey[]

const SETTINGS_KEY_SET: ReadonlySet<string> = new Set<string>(SETTINGS_KEYS)

export function isSettingsKey(value: string): value is SettingsKey {
  return SETTINGS_KEY_SET.has(value)
}

/**
 * A partial write.
 *
 * Strict on purpose: an unknown key is a mistake in the caller — a typo, or a
 * setting that was renamed — and silently dropping it is how a form ends up
 * saving nothing while reporting success.
 */
export const settingsPatchSchema = z
  .strictObject(settingsSchema.shape)
  .partial()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>
