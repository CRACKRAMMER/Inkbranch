import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { heading, info, report, run, style, warn } from '../lib/cli'

/**
 * Put the site's first rows in place: the owner's account, the settings row and
 * a starting navigation.
 *
 * **Idempotent.** Running it twice changes nothing the second time, and it never
 * resets something an admin has since edited — not the password, not the site
 * name, not the menu. That is the property that makes it safe to leave in a
 * deployment script, and it is why every write below is conditional rather than
 * an upsert: an upsert would silently undo an edit made in the admin, and the
 * person running this command would have no way to tell that it had.
 *
 * **The password is never generated.** A seed that invents a password and prints
 * it either prints a credential into a log or hands over an account nobody can
 * sign in to, and both are worse than refusing. `ADMIN_PASSWORD` is required for
 * a first run and the script stops with a non-zero exit code without it.
 *
 * The environment is read from `process.env` rather than from `@/env`, because
 * these three variables are this script's business and not the application's —
 * the app has no reason to hold the owner's password at runtime. `ADMIN_EMAIL`
 * and `ADMIN_NAME` are still validated here, with the same strictness, before
 * anything is written.
 */
const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

/** Header links that exist as routes in this application. */
const DEFAULT_HEADER_NAV = [
  { label: 'Posts', href: '/posts' },
  { label: 'Notes', href: '/notes' },
  { label: 'Projects', href: '/projects' },
  { label: 'Tags', href: '/tags' },
  { label: 'About', href: '/about' },
] as const

const DEFAULT_FOOTER_NAV = [
  { label: 'Archive', href: '/archive' },
  { label: 'Search', href: '/search' },
  { label: 'Graph', href: '/graph' },
  { label: 'RSS', href: '/rss.xml' },
] as const

void run('db:seed', async () => {
  const { db } = await import('@/lib/db')
  const { navigation, siteSettings, users } = await import('@/lib/db/schema')
  const { hashPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = await import(
    '@/lib/auth/password'
  )
  const { eq, sql } = await import('drizzle-orm')

  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
  const name = (process.env.ADMIN_NAME ?? '').trim()
  const password = process.env.ADMIN_PASSWORD ?? ''

  // Both are checked before the first write, so a half-seeded database is not a
  // possible outcome of a typo in `.env`.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'ADMIN_EMAIL is missing or is not an email address. Set it in .env (see .env.example).',
    )
  }
  if (!name) {
    throw new Error('ADMIN_NAME is missing. Set it in .env (see .env.example).')
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    // Deliberately no value, no length and no hint of the password in the
    // message: an error log is an append-only file that gets pasted into issues.
    throw new Error(
      `ADMIN_PASSWORD is missing or outside the accepted length (${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters). ` +
        'Set it in .env before seeding. This script will not generate one for you.',
    )
  }

  heading('Owner account')

  const [existingOwner] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1)

  if (existingOwner) {
    info(`${style.dim('·')} ${existingOwner.email} already exists; left untouched.`)
    info(style.dim('   Its password was not changed. Use the admin to change it.'))
  } else {
    const passwordHash = await hashPassword(password)
    await db.insert(users).values({ email, name, passwordHash, role: 'owner' })
    info(`${style.green('+')} created ${email} (owner)`)
  }

  heading('Settings')

  // `onConflictDoNothing` and not an upsert: an admin who renamed the site in
  // the settings screen must not find it renamed back by a deployment.
  const insertedSettings = await db
    .insert(siteSettings)
    .values({ id: 'default', authorName: name })
    .onConflictDoNothing({ target: siteSettings.id })
    .returning({ id: siteSettings.id })

  if (insertedSettings.length > 0) {
    info(`${style.green('+')} created the settings row (author: ${name})`)
  } else {
    info(`${style.dim('·')} the settings row already exists; left untouched.`)
  }

  heading('Navigation')

  const navRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(navigation)
  const navCount = navRows[0]?.count ?? 0

  if (navCount > 0) {
    info(`${style.dim('·')} ${navCount} menu items already exist; left untouched.`)
  } else {
    await db.insert(navigation).values([
      ...DEFAULT_HEADER_NAV.map((item, index) => ({
        location: 'header',
        label: item.label,
        href: item.href,
        position: index,
      })),
      ...DEFAULT_FOOTER_NAV.map((item, index) => ({
        location: 'footer',
        label: item.label,
        href: item.href,
        position: index,
      })),
    ])
    info(
      `${style.green('+')} created ${DEFAULT_HEADER_NAV.length} header and ${DEFAULT_FOOTER_NAV.length} footer items`,
    )
  }

  // Asked of the database rather than reported from the branches above: what the
  // summary says exists has to be what is actually there.
  const [userCounts, settingsCounts, navCounts] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(users),
    db.select({ count: sql<number>`count(*)::int` }).from(siteSettings),
    db.select({ count: sql<number>`count(*)::int` }).from(navigation),
  ])

  const userCount = userCounts[0]?.count ?? 0

  heading('Summary')
  report({
    Users: userCount,
    'Settings rows': settingsCounts[0]?.count ?? 0,
    'Menu items': navCounts[0]?.count ?? 0,
  })

  if (userCount === 0) {
    // Unreachable while the checks above pass, which is exactly why it is here:
    // if it ever prints, one of those checks stopped working.
    warn('No users exist after seeding. This is a bug in the seed script, not a configuration problem.')
    process.exitCode = 1
  } else {
    info(style.green('Seed complete. Sign in at /admin/login.'))
  }
})
