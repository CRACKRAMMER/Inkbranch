import 'server-only'

import { cache } from 'react'
import { revalidatePath, revalidateTag } from 'next/cache'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { navigation, type NavigationRow } from '@/lib/db/schema'
import { hrefKindProblem } from '@/lib/security/urls'

/**
 * Navigation menus.
 *
 * The `navigation` table is flat: `location`, `label`, `href`, `position`, and
 * no parent reference. A menu is therefore an ordered list and this module does
 * not pretend it is a tree — nesting needs a `parent_id` column and a cycle
 * check on write, and an item that claims children has nowhere to put them.
 *
 * What a flat table does not remove is the risk in the href. An admin account is
 * a plausible thing to steal, and an href is rendered straight into an anchor,
 * so every write validates the href against `@/lib/security/urls` before it
 * reaches the database: that is a stored-XSS sink closed for the price of a
 * string check.
 */

export const NAVIGATION_LOCATIONS = ['header', 'footer', 'social'] as const
export type NavigationLocation = (typeof NAVIGATION_LOCATIONS)[number]

export type NavigationItem = NavigationRow

/**
 * Ceiling on one menu.
 *
 * A limit rather than a promise: it bounds what a single write can do and what
 * the header has to render, and it is the number the admin UI counts against.
 */
export const MAX_NAVIGATION_ITEMS = 50

/** Cache tag for anything that renders a menu. Purged by the writes below. */
export const NAVIGATION_CACHE_TAG = 'navigation'

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type NavigationErrorReason =
  /** A location that is not `header`, `footer` or `social`. */
  | 'unknown_location'
  /** More items than `MAX_NAVIGATION_ITEMS`. */
  | 'too_many_items'
  /** An item whose fields do not match the schema. */
  | 'invalid_item'
  /** An href that is not a valid path, or not a valid external URL. */
  | 'invalid_href'

export class NavigationError extends Error {
  readonly code = 'NAVIGATION'
  readonly reason: NavigationErrorReason
  /** Position of the offending item in the submitted list, when there is one. */
  readonly index: number | null
  readonly issues: readonly string[]

  constructor(
    reason: NavigationErrorReason,
    message: string,
    options: { index?: number; issues?: readonly string[] } = {},
  ) {
    super(message)
    this.name = 'NavigationError'
    this.reason = reason
    this.index = options.index ?? null
    this.issues = options.issues ?? []
  }
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One item as submitted, before it is given a position.
 *
 * There is no `position` field: the array order is the order. Accepting a
 * position as well would let a caller send two items that claim the same one,
 * and the tie would be broken by whatever the sort happened to do.
 */
const navigationItemSchema = z.object({
  label: z.string().trim().min(1, 'Label cannot be empty').max(80),
  href: z.string().trim().min(1, 'Link cannot be empty').max(512),
  visible: z.boolean().default(true),
  external: z.boolean().default(false),
  /** Lucide icon name, used by the social location. */
  icon: z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Icon names are lower-case kebab-case')
    .nullish(),
})

export interface NavigationInput {
  label: string
  href: string
  visible?: boolean
  external?: boolean
  icon?: string | null
}

function describeIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string[] {
  return issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(item)'}: ${issue.message}`,
  )
}

export function isNavigationLocation(value: string): value is NavigationLocation {
  return (NAVIGATION_LOCATIONS as readonly string[]).includes(value)
}

function assertLocation(value: string): asserts value is NavigationLocation {
  if (!isNavigationLocation(value)) {
    throw new NavigationError(
      'unknown_location',
      `Unknown navigation location: ${value}`,
      { issues: [`Allowed locations: ${NAVIGATION_LOCATIONS.join(', ')}`] },
    )
  }
}

/**
 * Validate one submitted item and give it a position.
 *
 * The href is checked against the `external` flag rather than on its own: an
 * item marked internal whose href is `https://example.com` renders without
 * `rel="noopener noreferrer"`, and an item marked external whose href is
 * `/about` opens the site in a new tab for no reason. Either way the flag is
 * what the renderer trusts, so the flag has to be true.
 */
function toRow(
  input: NavigationInput,
  index: number,
  location: NavigationLocation,
): typeof navigation.$inferInsert {
  const parsed = navigationItemSchema.safeParse(input)
  if (!parsed.success) {
    throw new NavigationError(
      'invalid_item',
      `Menu item ${index + 1} is not valid.`,
      { index, issues: describeIssues(parsed.error.issues) },
    )
  }

  const item = parsed.data
  const hrefProblem = hrefKindProblem(item.href, item.external)
  if (hrefProblem) {
    throw new NavigationError(
      'invalid_href',
      `Menu item ${index + 1}: ${hrefProblem}`,
      { index, issues: [hrefProblem] },
    )
  }

  return {
    location,
    label: item.label,
    href: item.href,
    position: index,
    visible: item.visible,
    external: item.external,
    icon: item.icon ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface GetNavigationOptions {
  /** Include items that are switched off. The admin editor wants these; the header does not. */
  includeHidden?: boolean
}

/**
 * One menu, in order, in one query.
 *
 * The rows are flat, so there is nothing to assemble: this is a single indexed
 * read of `(location, position)`, not a query per item.
 *
 * Ordered by `position`, then `createdAt`, then `id`. `position` alone is not a
 * total order, and a tie broken by the database's mood is a menu that reshuffles
 * between requests. `createdAt` does not close it either: it defaults to `now()`,
 * which is transaction time, so every row written by one `saveNavigation` shares
 * a timestamp. The primary key closes it — arbitrary, but arbitrary in the same
 * direction every time.
 */
export async function getNavigation(
  location: NavigationLocation,
  options: GetNavigationOptions = {},
): Promise<NavigationItem[]> {
  assertLocation(location)

  const conditions = [eq(navigation.location, location)]
  if (!options.includeHidden) conditions.push(eq(navigation.visible, true))

  return db
    .select()
    .from(navigation)
    .where(and(...conditions))
    .orderBy(
      asc(navigation.position),
      asc(navigation.createdAt),
      asc(navigation.id),
    )
}

/** What the reading experience renders. Nothing else on the row is its business. */
export interface NavLink {
  label: string
  href: string
  external: boolean
  icon: string | null
}

/**
 * One menu for the site shell, memoised for the duration of the request.
 *
 * React's `cache` is per-request, so a header, a footer and a mobile drawer that
 * each ask for the same menu cost one query, and nothing survives into the next
 * request. An empty menu is `[]`, not an error: an unseeded site still renders.
 */
export const getNavLinks = cache(
  async (location: NavigationLocation): Promise<NavLink[]> => {
    const rows = await getNavigation(location)
    return rows.map((row) => ({
      label: row.label,
      href: row.href,
      external: row.external,
      icon: row.icon,
    }))
  },
)

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface NavigationWriteContext {
  /** `users.id` of the account making the change, for the audit row. */
  actorId?: string | null
  /** Hashed IP from `getRequestContext()`. Never the raw address. */
  ipHash?: string | null
}

/**
 * Purge the caches that render menus.
 *
 * As in `@/lib/settings`: outside a request Next throws for lack of something
 * to revalidate, and the menu has already been written by then. The failure is
 * logged rather than thrown, because the alternative is reporting a menu that
 * was saved as one that was not.
 */
function revalidateNavigation(): void {
  try {
    revalidateTag(NAVIGATION_CACHE_TAG, 'max')
    revalidatePath('/', 'layout')
  } catch (error) {
    console.error('[navigation] cache purge did not run; menus may be stale', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Replace one menu with `items`.
 *
 * Replace, not merge, and in a transaction: deleting the old items and
 * inserting the new ones as two unrelated statements would leave a window where
 * the menu is half a menu, and a partially-written menu is a menu with a
 * missing link.
 *
 * Returns the stored menu, positions included.
 */
export async function saveNavigation(
  location: NavigationLocation,
  items: readonly NavigationInput[],
  context: NavigationWriteContext = {},
): Promise<NavigationItem[]> {
  assertLocation(location)

  if (items.length > MAX_NAVIGATION_ITEMS) {
    throw new NavigationError(
      'too_many_items',
      `A menu holds at most ${MAX_NAVIGATION_ITEMS} items; received ${items.length}.`,
    )
  }

  // Validated before the transaction opens, so a bad item never costs a
  // rollback and the error names the item the caller sent.
  const rows = items.map((item, index) => toRow(item, index, location))

  const saved = await db.transaction(async (tx) => {
    await tx.delete(navigation).where(eq(navigation.location, location))
    if (rows.length === 0) return []
    return tx.insert(navigation).values(rows).returning()
  })

  await recordAudit({
    action: 'navigation.update',
    actorId: context.actorId ?? null,
    targetType: 'navigation',
    targetId: location,
    metadata: { location, count: saved.length },
    request: context.ipHash ? { ipHash: context.ipHash } : null,
  })

  revalidateNavigation()

  return saved
}
