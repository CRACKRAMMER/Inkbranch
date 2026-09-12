import { sql, relations } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { SEARCH_INDEX_VERSION } from '@/lib/search/provider'

/* -------------------------------------------------------------------------- */
/*  Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const contentTypeEnum = pgEnum('content_type', [
  'post',
  'note',
  'project',
])

export const contentStatusEnum = pgEnum('content_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
])

export const projectStatusEnum = pgEnum('project_status', [
  'active',
  'maintained',
  'experiment',
  'archived',
])

/**
 * `wiki` is an `[[Obsidian]]` reference. It is its own kind rather than a
 * flavour of `internal` because it may name a bare slug, and a bare slug can
 * only be narrowed to a type by whoever holds the content index — so the two
 * resolve by different rules and must stay distinguishable in the table.
 */
export const linkKindEnum = pgEnum('link_kind', ['internal', 'wiki', 'image', 'anchor'])

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'done',
  'failed',
])

export const deviceTypeEnum = pgEnum('device_type', [
  'desktop',
  'mobile',
  'tablet',
  'bot',
  'other',
])

/* -------------------------------------------------------------------------- */
/*  Custom column types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Postgres `bytea`. Drizzle has no first-class bytea, and revision snapshots
 * are gzip blobs, so we bridge it explicitly rather than base64-ing into text
 * (which would inflate storage by ~33%).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Argon2id encoded hash — includes salt and parameters. */
    passwordHash: text('password_hash').notNull(),
    /** Bumped on password change to invalidate every existing session. */
    sessionVersion: integer('session_version').notNull().default(1),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the raw token. The raw value only ever exists in the cookie. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Mirrors `users.session_version` so a password change kills sessions. */
    sessionVersion: integer('session_version').notNull().default(1),
    csrfTokenHash: varchar('csrf_token_hash', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 512 }),
    /** Hashed, never raw. Used only for the session list in settings. */
    ipHash: varchar('ip_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Content index                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One row per Markdown file. This is an *index*, never a vault: the body lives
 * only in `path`. Everything here is derivable by re-parsing the file, which is
 * exactly what `content:sync` does when the two drift apart.
 */
export const contentIndex = pgTable(
  'content_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: contentTypeEnum('type').notNull(),
    slug: varchar('slug', { length: 200 }).notNull(),
    /** POSIX-style path relative to CONTENT_DIR, e.g. `posts/foo.md`. */
    path: varchar('path', { length: 512 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    description: text('description'),
    status: contentStatusEnum('status').notNull().default('draft'),
    category: varchar('category', { length: 80 }),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** Frontmatter `updated`, falling back to filesystem mtime. */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** SHA-256 of the raw file bytes. The sync engine's identity function. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    wordCount: integer('word_count').notNull().default(0),
    readingTime: integer('reading_time').notNull().default(0),
    /** Size of the source file, used to skip hashing on the cheap boot check. */
    byteSize: integer('byte_size').notNull().default(0),
    fileMtime: timestamp('file_mtime', { withTimezone: true }),

    cover: varchar('cover', { length: 512 }),
    featured: boolean('featured').notNull().default(false),
    toc: boolean('toc').notNull().default(true),
    lang: varchar('lang', { length: 12 }).notNull().default('en'),
    series: varchar('series', { length: 160 }),

    /** Derived heading tree, so the article page skips re-parsing for the TOC. */
    headings: jsonb('headings')
      .$type<{ id: string; text: string; level: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    seoTitle: varchar('seo_title', { length: 300 }),
    seoDescription: text('seo_description'),
    canonicalUrl: varchar('canonical_url', { length: 512 }),
    ogImage: varchar('og_image', { length: 512 }),
    noindex: boolean('noindex').notNull().default(false),

    projectStatus: projectStatusEnum('project_status'),
    repoUrl: varchar('repo_url', { length: 512 }),
    websiteUrl: varchar('website_url', { length: 512 }),
    techStack: jsonb('tech_stack')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: date('started_at'),

    viewCount: integer('view_count').notNull().default(0),
    /**
     * Which version of the search document shape this row was indexed under.
     * Rows behind `SEARCH_INDEX_VERSION` need re-pushing before they can be
     * found; see `findStaleSearchRows` in the sync engine.
     */
    searchIndexVersion: integer('search_index_version')
      .notNull()
      .default(SEARCH_INDEX_VERSION),
    /** Frontmatter keys we do not model, preserved verbatim on round-trip. */
    extra: jsonb('extra')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    insertedAt: timestamp('inserted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('content_index_type_slug_unique').on(t.type, t.slug),
    uniqueIndex('content_index_path_unique').on(t.path),
    index('content_index_status_published_idx').on(t.status, t.publishedAt),
    index('content_index_type_updated_idx').on(t.type, t.updatedAt),
    index('content_index_featured_idx').on(t.featured),
    index('content_index_view_count_idx').on(t.viewCount),
  ],
)

/**
 * Full snapshots, gzip-compressed. Diffs are computed on demand between any two
 * snapshots, so no derived data is stored twice. Pruned to
 * `settings.revisions.maxPerContent` by a scheduled job.
 */
export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentId: uuid('content_id')
      .notNull()
      .references(() => contentIndex.id, { onDelete: 'cascade' }),
    revisionNo: integer('revision_no').notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    /** Complete file contents (frontmatter + body), gzipped. */
    snapshot: bytea('snapshot').notNull(),
    /** SHA-256 of the *uncompressed* snapshot, for cheap equality checks. */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    /** Human label: "Replaced by import", "Changed title", etc. */
    summary: varchar('summary', { length: 200 }).notNull().default('Saved'),
    authorId: uuid('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('content_revisions_content_no_unique').on(
      t.contentId,
      t.revisionNo,
    ),
    index('content_revisions_content_created_idx').on(t.contentId, t.createdAt),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Taxonomy and relations                                                     */
/* -------------------------------------------------------------------------- */

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    /** Optional accent, validated as a hex colour before it reaches CSS. */
    color: varchar('color', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tags_slug_unique').on(t.slug),
    index('tags_name_idx').on(t.name),
  ],
)

export const contentTags = pgTable(
  'content_tags',
  {
    contentId: uuid('content_id')
      .notNull()
      .references(() => contentIndex.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    /** Denormalised so `/tag/x` counts and tag clouds need one query. */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contentId, t.tagId] }),
    index('content_tags_tag_idx').on(t.tagId),
  ],
)

/**
 * Resolved outbound references. Powers backlinks ("Referenced by"),
 * unused-asset detection, and the broken-link report.
 *
 * `targetId` stays null when the link does not resolve; the row is still kept
 * so the link checker can report it without re-parsing every document.
 */
export const contentLinks = pgTable(
  'content_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => contentIndex.id, { onDelete: 'cascade' }),
    kind: linkKindEnum('kind').notNull(),
    /** Raw href as written in the Markdown. */
    href: varchar('href', { length: 1024 }).notNull(),
    /** Normalised slug for internal links; asset URL for images. */
    targetKey: varchar('target_key', { length: 1024 }).notNull(),
    targetId: uuid('target_id').references(() => contentIndex.id, {
      onDelete: 'set null',
    }),
    assetId: uuid('asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    label: varchar('label', { length: 300 }),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('content_links_source_idx').on(t.sourceId, t.kind),
    index('content_links_target_idx').on(t.targetId),
    index('content_links_asset_idx').on(t.assetId),
    index('content_links_target_key_idx').on(t.targetKey),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Assets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A scaled-down copy of an asset, written for the admin's grid.
 *
 * Not one of `variants`: a variant is the same picture at the same size in
 * another format, which is what makes it safe to offer a browser through a
 * `<picture>` element. This is a *smaller* picture, and substituting it for the
 * original would change the layout — so it is a field of its own rather than an
 * entry in a list every consumer already treats as interchangeable.
 *
 * `width` and `height` are stored because they are not the row's: the row
 * describes the original, and a scaled copy whose geometry is nowhere on the
 * record cannot be described without fetching the file to measure it.
 */
export interface AssetThumbnail {
  url: string
  width: number
  height: number
  size: number
}

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Path relative to UPLOAD_DIR, e.g. `2026/09/diagram.webp`. */
    path: varchar('path', { length: 512 }).notNull(),
    /** Public URL, e.g. `/uploads/2026/09/diagram.webp`. */
    url: varchar('url', { length: 512 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    /** Detected from magic bytes, never trusted from the request header. */
    mime: varchar('mime', { length: 100 }).notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** Tiny base64 WebP used as the placeholder while the image loads. */
    blurDataUrl: text('blur_data_url'),
    /** Content hash for deduplication on upload. */
    sha256: varchar('sha256', { length: 64 }).notNull(),
    /** Set when a re-encode produced a smaller AVIF/WebP sibling. */
    variants: jsonb('variants')
      .$type<{ format: string; url: string; size: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Null when there is nothing to scale: an SVG and an animation are stored
     * without derivatives, and an image already no larger than the thumbnail is
     * left alone rather than upscaled into a copy of itself.
     */
    thumbnail: jsonb('thumbnail').$type<AssetThumbnail>(),
    alt: varchar('alt', { length: 500 }),
    uploadedBy: uuid('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('assets_path_unique').on(t.path),
    index('assets_sha256_idx').on(t.sha256),
    index('assets_created_idx').on(t.createdAt),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Site configuration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Single-row settings table. A row is created by the seed script and its id is
 * fixed, which keeps reads trivial and lets the shape be typed end to end.
 */
export const siteSettings = pgTable('site_settings', {
  /** Fixed literal id — enforced by a check constraint in the migration. */
  id: varchar('id', { length: 16 }).primaryKey().default('default'),

  // Identity
  siteName: varchar('site_name', { length: 120 }).notNull().default('My Blog'),
  siteDescription: text('site_description')
    .notNull()
    .default('Personal knowledge system and publishing platform.'),
  authorName: varchar('author_name', { length: 120 }).notNull().default(''),
  /** Short line under the name on the home dashboard. */
  tagline: varchar('tagline', { length: 200 }).notNull().default(''),
  avatarUrl: varchar('avatar_url', { length: 512 }),
  locale: varchar('locale', { length: 12 }).notNull().default('zh-CN'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'),

  // SEO
  seoTitleTemplate: varchar('seo_title_template', { length: 200 })
    .notNull()
    .default('%s'),
  seoDefaultDescription: text('seo_default_description').notNull().default(''),
  twitterHandle: varchar('twitter_handle', { length: 80 }),
  googleVerification: varchar('google_verification', { length: 200 }),

  // Features
  analyticsEnabled: boolean('analytics_enabled').notNull().default(true),
  searchEnabled: boolean('search_enabled').notNull().default(true),
  graphEnabled: boolean('graph_enabled').notNull().default(true),
  commentsEnabled: boolean('comments_enabled').notNull().default(false),
  rssEnabled: boolean('rss_enabled').notNull().default(true),
  rssItemLimit: integer('rss_item_limit').notNull().default(30),

  // Git integration — never pushes, only commits.
  gitEnabled: boolean('git_enabled').notNull().default(false),
  gitAutoCommit: boolean('git_auto_commit').notNull().default(false),
  gitCommitTemplate: varchar('git_commit_template', { length: 200 })
    .notNull()
    .default('content: {action} "{title}"'),

  // Revisions
  revisionsEnabled: boolean('revisions_enabled').notNull().default(true),
  revisionsMaxPerContent: integer('revisions_max_per_content')
    .notNull()
    .default(50),

  // About page — structured, edited from the admin.
  aboutProfile: text('about_profile').notNull().default(''),
  aboutFocus: jsonb('about_focus')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  aboutCurrently: jsonb('about_currently')
    .$type<{ label: string; value: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  aboutStack: jsonb('about_stack')
    .$type<{ group: string; items: string[] }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  aboutContact: jsonb('about_contact')
    .$type<{ label: string; href: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  /** Free-form extras for future settings without a migration. */
  custom: jsonb('custom')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),

  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Enforce the single-row invariant in the database, not just by convention.
  check('site_settings_singleton', sql`${t.id} = 'default'`),
])

export const navigation = pgTable(
  'navigation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `header` | `footer` | `social` */
    location: varchar('location', { length: 32 }).notNull(),
    label: varchar('label', { length: 80 }).notNull(),
    href: varchar('href', { length: 512 }).notNull(),
    position: smallint('position').notNull().default(0),
    visible: boolean('visible').notNull().default(true),
    /** Opens in a new tab and gets `rel="noopener noreferrer"`. */
    external: boolean('external').notNull().default(false),
    /** Lucide icon name for the social location. */
    icon: varchar('icon', { length: 60 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('navigation_location_position_idx').on(t.location, t.position)],
)

export const redirects = pgTable(
  'redirects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromPath: varchar('from_path', { length: 512 }).notNull(),
    toPath: varchar('to_path', { length: 512 }).notNull(),
    statusCode: smallint('status_code').notNull().default(301),
    enabled: boolean('enabled').notNull().default(true),
    hits: integer('hits').notNull().default(0),
    note: varchar('note', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('redirects_from_path_unique').on(t.fromPath),
    index('redirects_enabled_idx').on(t.enabled),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Analytics — aggregate-only, privacy-first                                  */
/* -------------------------------------------------------------------------- */

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),
    path: varchar('path', { length: 512 }).notNull(),
    contentId: uuid('content_id').references(() => contentIndex.id, {
      onDelete: 'cascade',
    }),
    views: integer('views').notNull().default(0),
    visitors: integer('visitors').notNull().default(0),
    referrerDomain: varchar('referrer_domain', { length: 255 })
      .notNull()
      .default(''),
    device: deviceTypeEnum('device').notNull().default('other'),
    country: varchar('country', { length: 2 }).notNull().default(''),
  },
  (t) => [
    uniqueIndex('analytics_daily_dimensions_unique').on(
      t.day,
      t.path,
      t.referrerDomain,
      t.device,
      t.country,
    ),
    index('analytics_daily_day_idx').on(t.day),
    index('analytics_daily_content_idx').on(t.contentId),
  ],
)

/**
 * Raw events. **No IP address is ever stored**, and none is read: see
 * `src/lib/analytics/collect.ts` for the collection rules.
 *
 * `visitorHash` is an HMAC of the random value in the reader's first-party
 * visitor cookie, keyed by `SESSION_SECRET` with the day inside the digest. It
 * exists only to count uniques within a single day: it is not derived from the
 * machine, and the same cookie hashes differently tomorrow, so rows cannot be
 * joined into a history.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    path: varchar('path', { length: 512 }).notNull(),
    contentId: uuid('content_id').references(() => contentIndex.id, {
      onDelete: 'set null',
    }),
    referrerDomain: varchar('referrer_domain', { length: 255 })
      .notNull()
      .default(''),
    device: deviceTypeEnum('device').notNull().default('other'),
    country: varchar('country', { length: 2 }).notNull().default(''),
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull().default(''),
    /** Nav type: `navigate`, `reload`, `back_forward`, `prerender`. */
    navigationType: varchar('navigation_type', { length: 24 })
      .notNull()
      .default('navigate'),
    durationMs: integer('duration_ms').notNull().default(0),
  },
  (t) => [
    index('analytics_events_created_idx').on(t.createdAt),
    index('analytics_events_path_idx').on(t.path),
    index('analytics_events_content_idx').on(t.contentId),
  ],
)

/* -------------------------------------------------------------------------- */
/*  Operations                                                                 */
/* -------------------------------------------------------------------------- */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Stable machine key, e.g. `content.update`, `auth.login`. */
    action: varchar('action', { length: 80 }).notNull(),
    targetType: varchar('target_type', { length: 40 }),
    targetId: varchar('target_id', { length: 200 }),
    /** Never contains secrets; free of article bodies. */
    meta: jsonb('meta')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipHash: varchar('ip_hash', { length: 64 }),
    /** `ok` or `denied` — failed attempts are logged too. */
    outcome: varchar('outcome', { length: 16 }).notNull().default('ok'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_logs_created_idx').on(t.createdAt),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_user_idx').on(t.userId),
  ],
)

/**
 * Durable job queue. The worker claims rows with
 * `FOR UPDATE SKIP LOCKED`, so several workers can run concurrently without a
 * coordination service.
 */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Handler key registered in `src/lib/jobs/handlers.ts`. */
    type: varchar('type', { length: 60 }).notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    status: jobStatusEnum('status').notNull().default('pending'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 80 }),
    /** Deduplicates: at most one pending job per (type, key). */
    dedupeKey: varchar('dedupe_key', { length: 200 }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('scheduled_jobs_status_run_at_idx').on(t.status, t.runAt),
    uniqueIndex('scheduled_jobs_dedupe_unique')
      .on(t.type, t.dedupeKey)
      .where(sql`${t.status} = 'pending'`),
  ],
)

/**
 * Token-bucket rate limiting that survives restarts and works across replicas.
 * In-memory limiting would reset on every deploy, which is exactly when an
 * attacker would retry.
 */
export const rateLimits = pgTable('rate_limits', {
  key: varchar('key', { length: 200 }).primaryKey(),
  tokens: real('tokens').notNull(),
  lastRefillAt: timestamp('last_refill_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/* -------------------------------------------------------------------------- */
/*  Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  revisions: many(contentRevisions),
  assets: many(assets),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

export const contentIndexRelations = relations(contentIndex, ({ many }) => ({
  revisions: many(contentRevisions),
  tags: many(contentTags),
  outgoingLinks: many(contentLinks),
}))

export const contentRevisionsRelations = relations(
  contentRevisions,
  ({ one }) => ({
    content: one(contentIndex, {
      fields: [contentRevisions.contentId],
      references: [contentIndex.id],
    }),
    author: one(users, {
      fields: [contentRevisions.authorId],
      references: [users.id],
    }),
  }),
)

export const tagsRelations = relations(tags, ({ many }) => ({
  contents: many(contentTags),
}))

export const contentTagsRelations = relations(contentTags, ({ one }) => ({
  content: one(contentIndex, {
    fields: [contentTags.contentId],
    references: [contentIndex.id],
  }),
  tag: one(tags, { fields: [contentTags.tagId], references: [tags.id] }),
}))

export const contentLinksRelations = relations(contentLinks, ({ one }) => ({
  source: one(contentIndex, {
    fields: [contentLinks.sourceId],
    references: [contentIndex.id],
  }),
  target: one(contentIndex, {
    fields: [contentLinks.targetId],
    references: [contentIndex.id],
  }),
}))

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.userId], references: [users.id] }),
}))

/* -------------------------------------------------------------------------- */
/*  Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type ContentRow = typeof contentIndex.$inferSelect
export type NewContentRow = typeof contentIndex.$inferInsert
export type RevisionRow = typeof contentRevisions.$inferSelect
export type TagRow = typeof tags.$inferSelect
export type AssetRow = typeof assets.$inferSelect
export type RedirectRow = typeof redirects.$inferSelect
export type NavigationRow = typeof navigation.$inferSelect
export type SiteSettingsRow = typeof siteSettings.$inferSelect
export type AuditLogRow = typeof auditLogs.$inferSelect
export type ScheduledJobRow = typeof scheduledJobs.$inferSelect
export type AnalyticsDailyRow = typeof analyticsDaily.$inferSelect
export type ContentLinkRow = typeof contentLinks.$inferSelect

export type ContentType = (typeof contentTypeEnum.enumValues)[number]
export type ContentStatus = (typeof contentStatusEnum.enumValues)[number]
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number]
export type LinkKind = (typeof linkKindEnum.enumValues)[number]
export type DeviceType = (typeof deviceTypeEnum.enumValues)[number]
