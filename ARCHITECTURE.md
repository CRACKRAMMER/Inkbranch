# Architecture

> A personal knowledge system and publishing platform.
> Markdown files are the source of truth. The database is an index, not a vault.

---

## 1. Design Principles

These five rules decide every trade-off in the codebase. When in doubt, re-read them.

| # | Principle | Consequence |
|---|-----------|-------------|
| 1 | **Files own content, DB owns state** | Article bodies never live in Postgres. The DB stores metadata, indexes, sessions, analytics. |
| 2 | **Degrade to the filesystem** | If Postgres disappears, every published page still renders from `content/`. |
| 3 | **No silent corruption** | A failed save never touches the original file. Writes are atomic or they do not happen. |
| 4 | **Server first** | Pages are Server Components. Client JS is opt-in, per feature, and justified. |
| 5 | **Boring where it counts** | Auth, path handling, and file writes use well-understood primitives. Cleverness is reserved for the reading experience. |

---

## 2. System Overview

```
                       ┌──────────────────────────────┐
   Browser ──────────► │  Next.js (App Router, RSC)   │
                       │                              │
                       │  (site)   public reading     │
                       │  admin    CMS (auth-gated)   │
                       │  api      search / upload /  │
                       │           analytics collect  │
                       └───────┬──────────────┬───────┘
                               │              │
              ┌────────────────▼───┐    ┌─────▼──────────────────┐
              │  Content Engine    │    │  Postgres (Drizzle)    │
              │                    │    │                        │
              │  read  ──► cache   │    │  users, sessions       │
              │  write ──► atomic  │◄──►│  content_index         │
              │  sync  ──► index   │    │  tags, assets, links   │
              └────────┬───────────┘    │  revisions, audit      │
                       │                │  analytics, jobs       │
              ┌────────▼───────────┐    └────────────────────────┘
              │  content/*.md      │
              │  public/uploads/   │    ┌────────────────────────┐
              └────────────────────┘    │  Search Index (local)  │
                                        │  inverted, BM25, CJK   │
                                        └────────────────────────┘
```

### Read path

`content/*.md` → parse frontmatter → render Markdown (Shiki, server-side) → cache → RSC payload → HTML.
No database round-trip is required to render an article.

### Write path

```
Admin UI
  → Server Action (Zod validation + CSRF + session check)
  → serialize frontmatter + body
  → lock → write temp file → fsync → atomic rename → fsync(dir)
  → snapshot revision (gzip) + content_index upsert
  → invalidate cache, refresh search doc
  → optional git commit
  → revalidatePath
```

Every arrow after "serialize" is transactional or idempotent. If step 3 fails, the original file is untouched and the UI says so explicitly.

---

## 3. Content Model

### Directory layout

```
content/
  posts/      long-form articles      → /posts/<slug>
  notes/      short notes, snippets   → /notes/<slug>
  projects/   project pages           → /projects/<slug>
```

One file = one document. The filename is a hint; the frontmatter `slug` is authoritative.

### Frontmatter schema

Defined once in `src/lib/content/schema.ts` with Zod, shared by the parser, the validator, the CLI and the editor.

```yaml
---
title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "从 tcpdump 到 netstat 的一次完整排查记录"
date: 2026-09-11
updated: 2026-09-11
status: published          # draft | scheduled | published | archived
publishAt: 2026-10-01T09:00:00Z   # required when status: scheduled
tags: [Linux, Network]
category: Technology
cover: /uploads/2026/09/cover.webp
featured: false
toc: true
summary: "..."             # optional, overrides auto-derived excerpt
seo:
  title: "..."
  description: "..."
  canonical: "https://..."
  ogImage: "/og/..."
  noindex: false
series: "Kubernetes 深入"    # optional, groups posts
lang: zh
---
```

Unknown keys are preserved on round-trip (`_extra`) so hand-written frontmatter is never destroyed by an admin save.

### Notes are lighter

Notes accept a missing `title` (derived from the first heading or first line), a missing `description` (derived from the body), and a missing `slug` (derived from filename + date).

---

## 4. Database Schema

Postgres 16+. Drizzle ORM, SQL migrations checked in.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | Admin accounts. No open registration. | `email`, `password_hash` (Argon2id), `role`, `last_login_at` |
| `sessions` | Server-side sessions. | `token_hash` (SHA-256), `user_id`, `expires_at`, `user_agent`, `ip_hash` |
| `content_index` | One row per Markdown file. Powers lists, stats, search. | `type`, `slug` (unique w/ type), `path`, `title`, `status`, `published_at`, `updated_at`, `checksum`, `word_count`, `reading_time`, `view_count` |
| `content_revisions` | Gzipped full snapshots + stats. | `content_id`, `revision_no`, `snapshot` (bytea, gzip), `additions`, `deletions`, `author_id`, `summary` |
| `tags` | Canonical tag records. | `slug` (unique), `name`, `description`, `color` |
| `content_tags` | Many-to-many. | `content_id`, `tag_id` |
| `content_links` | Resolved internal links + image refs. Drives backlinks and "unused asset". | `source_id`, `kind` (`internal`\|`image`\|`anchor`), `target_slug`, `target_id`, `label` |
| `assets` | Uploaded media metadata. | `url`, `mime`, `size`, `width`, `height`, `blur_data_url`, `sha256`, `storage` |
| `redirects` | Legacy URL → new URL. Handles the Ghost migration. | `from_path` (unique), `to_path`, `status_code`, `enabled`, `hits` |
| `site_settings` | Single-row typed settings. | identity, SEO, analytics, features, git, appearance |
| `navigation` | Header / footer / social menus. | `location`, `label`, `href`, `position`, `parent_id` |
| `analytics_daily` | Pre-aggregated by day. | `date`, `path`, `content_id`, `views`, `referrer_domain`, `device`, `country` |
| `analytics_events` | Raw events, short retention, **no IP**. | `created_at`, `path`, `content_id`, `referrer_domain`, `device`, `visitor_hash` |
| `audit_logs` | Every mutating admin action. | `user_id`, `action`, `target_type`, `target_id`, `meta` (jsonb), `ip_hash` |
| `scheduled_jobs` | Durable queue for publish + retention jobs. | `type`, `run_at`, `status`, `attempts`, `locked_at`, `last_error` |

**Deliberately absent:** a `posts.body` column. Article text exists in exactly one place — the `.md` file.

### Why revisions live in the DB

The requirement allows `content/revisions/` or compressed diffs. We store **gzip-compressed full snapshots in `bytea`**, because:

- Restore is a single row read — no partial-chain corruption possible.
- `+23 −5` stats come from a diff computed on demand between any two snapshots, so we store no redundant derived data.
- The filesystem stays clean: `content/posts/*.md` is exactly the content, nothing else.
- Revisions are *history*, not *source*, so storing them in the DB does not violate principle #1.

Retention: `revisions.max_per_content` (default 50) is enforced by a scheduled job; older snapshots are pruned.

---

## 5. Content Engine

`src/lib/content/` is the only module allowed to touch `content/`.

| File | Responsibility |
|------|----------------|
| `schema.ts` | Zod schemas for frontmatter, per content type. |
| `frontmatter.ts` | Parse / serialize `---` blocks. Preserves unknown keys and key order. |
| `paths.ts` | Resolve + normalize + jail every path under `CONTENT_DIR`. |
| `reader.ts` | Read one doc / list docs, with an mtime+size cache. |
| `writer.ts` | Atomic write: lock → tmp → fsync → rename → fsync(dir). |
| `sync.ts` | Reconcile the filesystem against `content_index` by checksum. |
| `links.ts` | Extract internal links and image references from a document. |
| `derive.ts` | Slug, excerpt, word count, reading time, heading tree. |

### Atomic write contract

```
acquire lock (content/.locks/<type>-<slug>.lock, O_EXCL, stale after 10s)
  write content/.tmp/<uuid>.md
  fsync(file)
  rename(tmp, target)          ← atomic on POSIX, same filesystem
  fsync(dir)
release lock
```

`rename()` is atomic, so a reader either sees the old file or the new one — never a half-written one. If the process dies mid-write, the tmp file is orphaned and the target is intact. Orphan tmp files are swept on startup.

Every save also writes a pre-write snapshot into `content_revisions`, so even an accepted-but-wrong edit is recoverable.

### Content Sync Engine

Files can change behind the app's back (`git pull`, `vim`, a container mount, the admin UI). `syncContent()` is the single reconciler:

```
scan content/**.md
  → checksum each file (sha256 of raw bytes)
  → compare with content_index
      file missing in DB               → INSERT
      checksum differs                 → UPDATE (+ new revision)
      DB row whose file is gone        → mark deleted / remove row
      unchanged                        → skip
  → reparse frontmatter, refresh tags + links
  → mark search docs dirty
```

Triggers:
- `pnpm content:sync` (full, verbose)
- On app boot — a **lightweight** pass that only stats mtimes (no hashing) and runs the full sync in the background if anything moved.
- After every admin save (targeted, single document).

The scan is bounded: `CONTENT_MAX_FILES` (default 5000) guards against a mis-mounted volume turning boot into a filesystem walk of `/`.

---

## 6. Markdown Pipeline

Server-side only. Zero client JS for rendering.

```
raw markdown
  → remark-parse
  → remark-gfm          tables, task lists, footnotes, strikethrough
  → remark-frontmatter  (consumed by our own parser, stripped here)
  → remark-math         $inline$ and $$block$$
  → remark-directive    :::note / :::warning containers
  → custom: file trees, tabs, keys, details, callouts
  → rehype-slug + rehype-autolink-headings
  → rehype-katex
  → rehype-pretty-code (Shiki, dual themes, line/word highlight, diff)
  → rehype-sanitize     (schema extended for our own nodes)
  → rehype-stringify
```

**Shiki runs at build/render time on the server.** The client receives pre-highlighted HTML with dual `--shiki-light` / `--shiki-dark` CSS variables. Theme switching is a CSS class change — no re-highlight, no highlighter bundle on the client.

Only `copy` buttons, Mermaid, and interactive tabs ship client JS, and Mermaid is dynamically imported only if the document actually contains a diagram.

### Supported syntax

Headings · tables · blockquotes · task lists · footnotes · KaTeX · Mermaid · GitHub alerts (`> [!NOTE]`) · `<details>` · definition lists · images · video · iframe (allow-listed origins) · code blocks · diff · tabs · callouts · `<kbd>` · file trees.

### Security

`rehype-sanitize` runs last with an explicit allow-list. Raw HTML is permitted only for tags we know. `iframe` is restricted to a configured origin allow-list. This closes the Markdown-XSS vector from `dangerouslySetInnerHTML`.

---

## 7. Search

`src/lib/search/` exposes a `SearchProvider` interface so Meilisearch can be swapped in later without touching call sites.

```
interface SearchProvider {
  search(q: string, opts): Promise<SearchHit[]>
  upsert(doc: SearchDocument): Promise<void>
  remove(id: string): Promise<void>
  rebuild(docs: SearchDocument[]): Promise<void>
}
```

The shipped provider is **local, in-process, BM25**:

- **Tokenization:** ASCII words (lowercased, stem-free, length ≥ 2) **plus CJK bigrams**. Bigrams give useful Chinese recall without a dictionary-based segmenter and without a native dependency.
- **Fields:** `title` (boost 5), `tags` + `category` (boost 3), `description` (boost 2), `body` (boost 1).
- **Persistence:** `.cache/search-index.json`, keyed by each document's checksum. Rebuild only touches changed documents.
- **Lifetime:** a module-level singleton, lazily built on first query, invalidated by the content engine on write.
- **Query syntax:** `tag:linux`, `type:note`, `before:2026-01`, `after:2025-06`, plus plain terms.

The palette (`Cmd/Ctrl+K`) queries `/api/search` (debounced, `AbortController`-cancelled). The response is small JSON; the palette renders it. Command mode (`>theme`, `>admin`, `>rss`) is resolved entirely on the client — no round-trip.

---

## 8. Relations

Three independent mechanisms, no AI involved.

1. **Backlinks** — `content_links` rows with `kind = 'internal'` pointing at a resolved `target_id`. Reverse lookup gives "Referenced by".
2. **Related content** — a weighted score over shared tags (Jaccard), same category, shared internal links, and title-keyword overlap. Computed at request time from `content_index` + tag sets; results are cached per slug.
3. **Knowledge graph** — nodes are documents and tags; edges are `content_tags` plus `content_links`. Serialized to a compact `{nodes, edges}` payload, fetched only when `/graph` mounts, rendered on canvas with a small hand-written force layout.

Keeping the graph off the main bundle is a hard requirement: `/graph` is the only route that imports it, and the route is `dynamic = 'force-static'` with client-side fetch of `/api/graph`.

---

## 9. Security Model

| Area | Control |
|------|---------|
| Passwords | Argon2id (`@node-rs/argon2`), per-password salt, tuned memory cost. |
| Sessions | 32 random bytes, stored **hashed** (SHA-256) in `sessions`. Cookie: `HttpOnly`, `Secure` (production), `SameSite=Lax`, `Path=/`, rotating on login. Absolute + idle expiry. |
| CSRF | Double-submit token bound to the session, plus `Origin`/`Sec-Fetch-Site` verification on every mutating request. Server Actions get an explicit check in the shared guard. |
| Rate limiting | Token bucket in Postgres for login (`5 / 15 min / ip_hash`) and uploads. Survives restarts, works across replicas. |
| Path traversal | Every path is built with `path.resolve` then verified with `isInside(root, p)` using `path.relative` — never string `startsWith`. Applies to content paths, upload paths, and ZIP entries. |
| Uploads | MIME sniffed from magic bytes (not the `Content-Type` header), extension derived from the sniff. SVG is sanitized (scripts, `on*`, `foreignObject`, external refs stripped) or served as a download. |
| Markdown XSS | `rehype-sanitize` allow-list, iframe origin allow-list. |
| Authz | A single `requireAdmin()` guard at the top of every admin action; admin layout also enforces it, so there is no unprotected surface even if a page forgets. |
| Audit | Every mutation writes `audit_logs` with actor, action, target, and a redacted diff summary. |

Secrets (`SESSION_SECRET`, `DATABASE_URL`) are validated at boot by `src/env.ts`; the app refuses to start in production with a default or short secret.

---

## 10. Rendering & Caching

| Route class | Strategy | Revalidation |
|-------------|----------|--------------|
| `/`, `/posts`, `/notes`, `/projects`, `/archive`, `/tags` | Dynamic RSC, data from the content cache | `revalidatePath` on save + tag-based `revalidateTag('content')` |
| `/posts/[slug]`, `/notes/[slug]`, `/projects/[slug]` | Dynamic RSC — no `generateStaticParams`, and the body is read from the file on every request | On-demand revalidation from the write path |
| `/graph`, `/admin/*` | Client-heavy, never prerendered | — |
| `/rss.xml`, `/atom.xml`, `/rss/[tag]`, `/rss/category/[category]`, `/sitemap.xml` | Route handlers, `force-dynamic` — the build has no database to read | Nothing to invalidate: rendered per request, then cached by shared caches |
| `/robots.txt` | `MetadataRoute`, prerendered — it reads `SITE_URL` and nothing else | A rebuild |

Public pages are served with `s-maxage=3600, stale-while-revalidate=86400`. The feeds set their own — `public, max-age=600, s-maxage=3600, stale-while-revalidate=86400` — because a feed is cheap to render and the reader being served is an aggregator that polls on its own schedule; a subscriber may be a few minutes behind a publish without anything being wrong.

### Feeds

Four addresses, one implementation. `/rss.xml` and `/atom.xml` are the site feed in two serialisations; `/rss/<tag>.xml` and `/rss/category/<category>.xml` are one topic each. `src/app/rss/_feeds.ts` holds the shared half — settings, the document list, the item limit, the response headers — and each route file holds only its address, so the four cannot come to disagree about what a feed is.

Two details of the addresses are not obvious:

- **The `.xml` suffix is part of the URL, not an extension.** A Next dynamic segment cannot carry a literal suffix, so `/rss/linux.xml` is served by `[tag]` with `params.tag === 'linux.xml'`, and `feedSlug` is what turns a segment into a topic or refuses it. A segment without the suffix is not a feed address, and `/rss/linux` therefore answers with this site's "no feed is served at this address" rather than an empty feed — a reader handed an empty feed unsubscribes from a topic that never existed.
- **`/rss/category/…` is a static segment beside `[tag]`,** which Next prefers, so a two-segment path under `/rss/` is always a category and a one-segment path is always a tag.

What a topic has to be to have a feed:

| Topic | Lookup | Why |
|-------|--------|-----|
| Tag | `getTag(slug)` — only tags with published content behind them | The same lookup `/tags/<slug>` uses, so a tag page that 404s and a tag feed that served an empty document cannot both happen |
| Category | `countContent({ category }) > 0` — visible documents only | A category exists only as a string on documents, so a draft-only category must not have a feed that says it does |

Documents are matched by the stored string (`doc.category === name`, tag name membership), so one category has exactly one feed URL — case-sensitively: `atom:link rel="self"` can only name one address, and a forgiving comparison would put two in circulation.

**Every page states its own feed links.** Next replaces `alternates` wholesale when a page sets it, so the root layout's `<link rel="alternate">` reaches the home page and nothing else. `buildPageMetadata` therefore emits the site feeds on every page that is not about a topic, and a tag page publishes its own tag feed *instead* — which is why the layout's copy is documented as the answer for the one route that renders no metadata of its own.

## 11. Observability

`/admin/system` reports: content index freshness (rows vs. files), search index state, upload directory size, DB size, pending scheduled jobs, failed jobs, and the last 50 audit entries. `src/lib/health.ts` exposes the same checks for `docker healthcheck`.

---

## 12. Directory Map

```
src/
  app/
    (site)/            public reading experience
    admin/             CMS
    api/               search, upload, analytics, graph, preview, health
  components/
    ui/                shadcn-style primitives (Radix + CVA)
    site/              reading experience
    admin/             CMS components
    markdown/          renderer + interactive block wrappers
  lib/
    content/           the only module that touches content/
    markdown/          unified pipeline + plugins
    db/                drizzle schema, client, migrations
    auth/              sessions, passwords, guards, csrf, rate limit
    search/            provider interface + local BM25 provider
    analytics/         collection, aggregation, retention
    seo/               metadata, JSON-LD, feeds, OG images
    jobs/              scheduled job runner + handlers
    git/               optional content auto-commit
    security/          path jail, mime sniffing, sanitizers
    settings/          typed site settings accessors
  env.ts               validated environment
scripts/               CLI (content:*, db:*, backup)
tests/                 unit + integration + e2e
content/               Markdown source of truth
public/uploads/        media
```

---

## 13. Trade-offs & Known Limitations

Recorded honestly, because a design document that only lists wins is marketing.

1. **Bigram CJK tokenization** over-segments rare terms and cannot do prefix matching on single Chinese characters. Acceptable for a single-author site; Meilisearch is the escape hatch, and the provider interface exists for it.
2. **In-process search index** does not survive to multi-instance deployments. A second replica would either build its own copy (fine, it is cheap) or talk to an external provider.
3. **Revisions in `bytea`** grow the database. Pruning is a scheduled job, and the default of 50 per document bounds it.
4. **Git auto-commit** shells out to `git` and assumes the content directory is already a repository with a clean identity. It is off by default and never pushes.
5. **No multi-author workflow.** Roles exist in the schema (`owner` / `editor`), but there is no review queue or editorial approval step.
6. **Analytics are aggregate-only by design.** No funnels, no sessions, no cohorts — this is a deliberate product boundary, not an unfinished feature.
