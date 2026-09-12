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
              │  uploads/          │    ┌────────────────────────┐
              └────────────────────┘    │  Search Index (local)  │
                                        │  inverted, BM25, CJK   │
                                        └────────────────────────┘
```

### Read path

`content/*.md` → parse frontmatter → render Markdown (Shiki, server-side) → cache → RSC payload → HTML.
No database round-trip is required to render an article.

### Pages that are not a document

Most public pages are one document or a list of them. `/about` is seven blocks with no file behind
it: profile, focus, currently, stack, projects, contact and latest writing. Five are settings —
editable from `/admin/settings`, because they are facts the author changes once a year and should
not have to open an editor to fix — and two are read from `content_index`, so a page written last
year still says what the author is working on now. The profile is rendered as paragraphs and never
as Markdown: settings are written from a form, and the one input this site turns into HTML is
content, which goes through a sanitiser. The home page is composed the same way — identity from
settings, blocks from the index — and `src/app/(site)/about/page.tsx` carries the reasoning.

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

Postgres. The floor is 13, and it is set by `gen_random_uuid()`, which is the newest thing the schema asks for; `docker-compose.yml` pins `postgres:17-alpine`, and 17 is what this is tested against. Drizzle ORM, SQL migrations checked in under `src/lib/db/migrations/`.

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

### Git auto-commit

Optional, off by default, and never pushes. `src/lib/git/` shells out to `git`
after a write has already succeeded, so the content directory keeps a commit
history alongside its files:

```
content: update "Linux Network Debugging"
content: publish "Linux Network Debugging"
content: delete "Linux Network Debugging"
content: tag "linux → unix"            (one commit for the whole rewrite)
content: publish "12 documents"        (one commit for a bulk run)
```

**Two switches have to agree.** The settings (`gitEnabled`, `gitAutoCommit`) say
whether the *site* wants commits; `GIT_INTEGRATION_ENABLED` says whether the
*deployment* permits them, and no admin screen can turn it on. Three
combinations matter:

| settings | env | behaviour |
|----------|-----|-----------|
| off | any | silence — the site never asked for this |
| on | `0` | a `deployment-disabled` note in the editor after every save, and in the log |
| on | `1` | the commit is attempted and its outcome reported |

**One commit per decision, not per file.** A save, a deletion and a revision
restore commit their document. A bulk operation and a tag rename commit once for
the whole run, naming every file it actually wrote — forty entries in the log for
one rename is noise, and forty files are one decision.

**What is enforced, not promised** (`src/lib/git/index.ts`):

- `GIT_SUBCOMMANDS` is an allow-list — `add`, `commit`, `rev-parse`, `status`,
  `var` — checked before every spawn, so `push` is not a code path this module
  has. Nothing here reaches a remote.
- Every command carries an explicit pathspec, so a change the operator has staged
  themselves, or a stray file beside the documents, cannot ride along in a commit
  called `content: update "…"`. `:(literal)` neutralises globbing; absolute paths,
  `..` and leading `-` are refused.
- `execFile` with an argument array: no shell, so a title containing `$(…)` is a
  title.
- Commits are chained within the process, because two that overlap race for
  `.git/index.lock`. A second process is not coordinated — that is a logged
  failure, not a lost save.

**A commit cannot fail a save.** The file is written first; the commit is the
last thing an action does and every outcome — no repository, no identity, no
`git` binary, nothing to commit, git refusing — is a described result. Failures
go to the server log in git's own words; the browser is told a classification
(`src/lib/git/message.ts`), never a transcript, because git's stderr can carry
paths. The editor shows the phrase beside the save, never as the save.

**Messages** come from `gitCommitTemplate` (`content: {action} "{title}"` by
default), with `{action}` one of `create`, `update`, `publish`, `unpublish`,
`delete`, `restore`, `tag`. Titles are flattened to one line and capped at 100
characters — a newline in a title would otherwise become a commit body, which is
not what the template promised — and an unknown placeholder is left as typed.
The template default lives in exactly one place: `DEFAULT_COMMIT_TEMPLATE`, which
`SETTINGS_DEFAULTS` re-uses.

**How it is tested.** `tests/unit/git.test.ts` runs the real thing against
repositories it creates under a throwaway content root: the message rules, the
allow-list, pathspec scoping, a deletion, and every failure mode as an outcome
rather than a rejection. `tests/integration/git-commit.test.ts` composes the
admin half against a real settings row. `tests/e2e/git.spec.ts` is the one that
puts the claim end to end: it turns the switches on in the settings UI, publishes
a post through the editor, and checks that the `committed <sha>` it was shown is
the repository's `HEAD`. That last assertion is the point of the file — the
phrase is the product's only claim about the commit, so a suite that believed it
would pass against a status line that lies.

---

## 6. Markdown Pipeline

Server-side only. Zero client JS for rendering. Frontmatter is not part of this pipeline: `src/lib/content/frontmatter.ts` splits it off and parses it before any Markdown is rendered.

```
raw markdown
  → remark-parse
  → remark-gfm            tables, task lists, footnotes, strikethrough
  → remark-deflist        definition lists
  → remark-math           $inline$ and $$block$$
  → remark-directive      :::note containers
  → remark-blocks         file trees, tabs, keys, details (ours)
  → remark-alerts         > [!NOTE] GitHub alerts (ours)
  → remark-display-math   rewrites $$-fenced inline math into a display node (ours)
  → mdast → hast          remark-rehype, allowDangerousHtml, our own handlers
  → rehype-capture-code-meta   moves fence meta off the node before rehype-raw (ours)
  → rehype-raw
  → rehype-sanitize       explicit allow-list, extended for the nodes above
  → rehype-enhance        heading ids, table wrappers, link policy, <picture> (ours)
  → rehype-code           Shiki, dual themes, diff and line highlights (ours)
  → rehype-katex
  → feature collection    what the page must know about its own markup (ours)
  → rehype-stringify
```

Plugin names in this list are the ones in `package.json`; the passes marked *(ours)* are in `src/lib/markdown/`. There is no `rehype-pretty-code`, no `rehype-slug` and no `rehype-autolink-headings` here — the capabilities are present, but they are this project's own passes, which is what allows them to run in the order below.

**Order carries two decisions.** First, `rehype-sanitize` runs *before* the transformers that emit this site's markup, not after: everything downstream of it (`rehypeEnhance`, `rehypeCode`, `rehypeKatex`) produces markup this project controls, so there is nothing left to sanitise and `rehypeEnhance` may emit a `<picture>` the allow-list does not carry. Second, `rehypeCaptureCodeMeta` runs before `rehype-raw`, because the parse5 round trip cannot carry data on the node.

**Shiki runs at build/render time on the server.** The client receives pre-highlighted HTML with dual `--shiki-light` / `--shiki-dark` CSS variables. Theme switching is a CSS class change — no re-highlight, no highlighter bundle on the client.

Only `copy` buttons, Mermaid, and interactive tabs ship client JS, and Mermaid is dynamically imported only if the document actually contains a diagram.

### Supported syntax

Headings · tables · blockquotes · task lists · footnotes · KaTeX · Mermaid · GitHub alerts (`> [!NOTE]`) · `<details>` · definition lists · images · video · iframe (allow-listed origins) · code blocks · diff · tabs · callouts · `<kbd>` · file trees.

### Security

`rehype-sanitize` runs early, with an explicit allow-list, over everything the author wrote: raw HTML survives only for tags on that list and only with the attributes listed for them, so `script`, `style` and event handlers do not. What runs after it is this project's own code, emitting markup the author influences only through the inputs it was handed — which is why nothing downstream is sanitised again.

An `iframe` is on the allow-list, but two things have to be true at once: the sanitiser keeps the element with a restricted attribute set, and `rehypeEnhance` then removes any whose source is not on `ALLOWED_EMBED_ORIGINS`. Two checks rather than one, because the sanitiser cannot know which origins this site trusts.

Together these close the Markdown-XSS vector at `dangerouslySetInnerHTML`.

---

## 7. Search

`src/lib/search/` exposes a `SearchProvider` interface so Meilisearch can be swapped in later without touching call sites.

```ts
interface SearchProvider {
  readonly name: string
  search(query: SearchQuery): Promise<SearchResult>
}
```

**Two methods, and the interface is small on purpose.** An earlier shape also carried `upsert`, `remove` and `rebuild`, which were dropped: those are the shape of a *local* store — a thing that holds the index and has to be told about every edit — and requiring them of a remote implementation would push a local store's bookkeeping onto a service that keeps its own. A provider that needs to know a document changed can hear it from `src/lib/admin/revalidate.ts`, which is where the shipped one hears it.

The shipped provider is **local, in-process, BM25**:

- **Tokenization:** ASCII words **plus CJK bigrams**. Bigrams give useful Chinese recall without a dictionary-based segmenter and without a native dependency. Words are reduced to a conservative stem (`render`, `renders` and `rendering` are one term) and there is no length floor — the index stores both the written form and its stem, so `postgres` → `postgre` costs nothing in recall.
- **Fields:** `title` (weight 8), `tags` (6), `category` (5), `description` (4), `headings` (3), `body` (1) — `FIELD_WEIGHTS` in `src/lib/search/local.ts`, which records why `category` sits between `tags` and `description`.
- **Persistence:** none. There is no index file. The index is built in-process from the content tree, and a tree fingerprint decides whether to rebuild — checked at most once every `FINGERPRINT_TTL_MS` (5 s), so a burst of queries walks the tree once.
- **Lifetime:** a module-level singleton, lazily built on first query, explicitly invalidated on write by `src/lib/admin/revalidate.ts`.
- **Query syntax:** `type:note`, `tag:linux` / `tags:linux`, `category:engineering` / `categories:engineering`, quoted phrases, and plain terms. An unrecognised `name:value` is not silently ignored: it comes back in `ParsedQuery.unsupported` and the search page and the palette both tell the reader which filter was not applied. `before:` and `after:` are in that category — they are not implemented, and the reader is told so rather than being handed unfiltered results.

The palette (`Cmd/Ctrl+K`) queries `/api/search` (debounced, `AbortController`-cancelled). The response is small JSON; the palette renders it. Command mode (`>theme`, `>admin`, `>rss`) is resolved entirely on the client — no round-trip.

---

## 8. Relations

Three independent mechanisms, no AI involved.

1. **Backlinks** — `content_links` rows with `kind = 'internal'` pointing at a resolved `target_id`. Reverse lookup gives "Referenced by".
2. **Related content** — a weighted score over shared tags (Jaccard), same category, shared internal links, and title-keyword overlap. Computed at request time from `content_index` + tag sets; results are cached per slug.
3. **Knowledge graph** — nodes are documents and tags; edges are `content_tags` plus `content_links`. Serialized to a compact `{nodes, edges}` payload, fetched only when `/graph` mounts, rendered on canvas with a small hand-written force layout.

Keeping the graph off the main bundle is a hard requirement: `/graph` is the only route that imports it, and the route renders a client component that fetches `/api/graph` from the browser. The page itself declares no caching of its own — it sits under the public layout, which is `force-dynamic` (§10) — and it is the `/api/graph` response that carries the cache headers: `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.

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

**The public reading tree is `force-dynamic`.** There is no `generateStaticParams`, no `revalidate` export, and no ISR anywhere in `src/app/(site)/` — one export on the layout covers the whole group.

| Route class | Strategy | Freshness |
|-------------|----------|-----------|
| `/`, `/posts`, `/notes`, `/projects`, `/archive`, `/tags`, `/search` | Dynamic RSC, rendered per request | `revalidateContentChange` on save, clearing the client router cache for the affected paths |
| `/posts/[slug]`, `/notes/[slug]`, `/projects/[slug]` | Dynamic RSC — the body is read from the file on every request | Same |
| `/graph`, `/admin/*` | Rendered per request, never prerendered — `/graph` renders a client component that fetches `/api/graph` | — |
| `/rss.xml`, `/atom.xml`, `/rss/[tag]`, `/rss/category/[category]`, `/sitemap.xml` | Route handlers, `force-dynamic` — the build has no database to read | Nothing to invalidate: rendered per request, then cached by shared caches |
| `/robots.txt` | `MetadataRoute`, prerendered — it reads `SITE_URL` and nothing else | A rebuild |

**Why the reading tree is dynamic** (`src/app/(site)/layout.tsx` argues it at length): the content tree is a volume, and the image is meant to be byte-identical whatever is published alongside it. A build that reads the content tree bakes the published state into the image, which fails quietly and in the wrong direction. Rendering on demand costs a handful of indexed queries against a local Postgres per request and buys three things: a publish is visible immediately, the build needs no database, and the image cannot contain content. It also covers the changes that never pass through the admin — a file dropped into `content/`, a `content:sync`, the worker flipping a scheduled post to published. None of those call `revalidatePath`, and under a time-based cache each would be invisible until the window elapsed.

What is left to invalidate is the *client* router cache: without it, a client-side navigation back to a list page would serve the router's cached copy. That is `revalidateContentChange` in `src/lib/admin/revalidate.ts`, and it is the whole of the freshness mechanism.

**Public pages carry no `Cache-Control` of their own.** Three routes set one, and only three: the feeds (`public, max-age=600, s-maxage=3600, stale-while-revalidate=86400` — a feed is cheap to render and the reader is an aggregator that polls on its own schedule, so a subscriber a few minutes behind a publish is not a problem), `/api/graph` (`max-age=300, s-maxage=3600, stale-while-revalidate=86400`), and the OG image route. Documentation elsewhere may describe a blanket `s-maxage` on article routes; there is none, and there should not be one on a tree that is deliberately dynamic.

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

`/admin/system` reports: content index freshness (rows vs. files), search index state, upload directory size, DB size, pending scheduled jobs, failed jobs, and the last 50 audit entries.

`docker healthcheck` uses a narrower surface: `GET /api/health` (`src/app/api/health/route.ts`) checks the database and the content-index drift, and answers 503 only when the database is unreachable. Drift alone is `degraded` with a 200 — a build that comes up before the sync job has run is not a container that should be restarted, and saying so is the difference between a healthcheck that reports and one that flaps.

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
uploads/               media (public/uploads/ when running `pnpm dev`)
```

---

## 13. Trade-offs & Known Limitations

Recorded honestly, because a design document that only lists wins is marketing.

1. **Bigram CJK tokenization** over-segments rare terms and cannot do prefix matching on single Chinese characters. Acceptable for a single-author site; Meilisearch is the escape hatch, and the provider interface exists for it.
2. **In-process search index** does not survive to multi-instance deployments. A second replica would either build its own copy (fine, it is cheap) or talk to an external provider.
3. **Revisions in `bytea`** grow the database. Pruning happens in the write path rather than in a job: a named save trims the document's named revisions to `revisionsMaxPerContent` (50 by default) as soon as the new one is written, and autosaves are trimmed by the store within its own transaction to a larger bound of their own. The bound is therefore per document — deleting a document cascades its history away, and no background task has to run for the database to stay finite.
4. **Git auto-commit** shells out to `git` and assumes the content directory is already a repository (or inside one) with a configured identity — a container needs git installed for it to do anything. It is off by default, needs two switches to agree, and never pushes. Commits are serialised within one process only; two processes committing at once contend on the index lock and the loser is logged and skipped.
5. **No multi-author workflow.** Roles exist in the schema (`owner` / `editor`), but there is no review queue or editorial approval step.
6. **Analytics are aggregate-only by design.** No funnels, no sessions, no cohorts — this is a deliberate product boundary, not an unfinished feature.
