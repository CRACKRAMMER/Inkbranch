# MyBlog

A personal knowledge system and publishing platform: a public reading site, a
full content management backend, and a content pipeline in which **Markdown
files on disk are the source of truth**.

It is not a Ghost clone and it does not sit on top of a headless CMS. Three
content layers — posts, notes and projects — share one Markdown pipeline, one
search index, one set of relations (backlinks, related content, a knowledge
graph), and one admin.

- Reading experience, content model and rendering pipeline: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Running it in production: [DEPLOYMENT.md](./DEPLOYMENT.md)
- What was built, what was not, and why (Chinese): [DELIVERY.md](./DELIVERY.md)

---

## The decision everything else follows from

Article bodies are never stored in Postgres. A post exists in exactly one
place: a file under `content/`. The database holds what the files cannot — the
content index (for lists, stats and search), tags and link edges, revisions,
assets, redirects, settings, navigation, sessions, analytics and the audit log.

This is worth stating up front because it explains most of the shapes in the
codebase:

- **Editing a file is publishing.** `git pull`, `vim`, or dropping a `.md` into
  `content/` is a supported way to update the site. `pnpm content:sync` (and a
  lightweight check on boot) reconciles the index against whatever is on disk.
- **`src/lib/content/` is the only module that touches `content/`.** Reads,
  writes and path handling go through it. Writes are atomic — lock, temp file,
  `fsync`, `rename`, `fsync(dir)` — so a failed save never damages the file it
  was replacing.
- **The public site renders per request.** Nothing database-backed is
  prerendered at build time, so the Docker build needs no database and the
  image cannot contain a snapshot of your development content. See the comment
  in `src/app/(site)/layout.tsx` for the full reasoning.
- **Postgres can disappear and the site still reads *content*.** Article bodies
  and their metadata come from the filesystem, so nothing is lost when the
  database is gone. The site does not keep *serving* without it, though: the
  public layout reads settings and navigation on every render, so a Postgres
  outage is an outage. What the file-first design buys is that the content — the
  part that took years to write — is never trapped behind a database, not that
  the site is immune to one.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 22+ | `engines.node` is `>=22`. The Docker image is `node:22-alpine`. |
| pnpm | `packageManager` pins `pnpm@12.3.4`; Corepack reads it. `corepack enable` is enough. |
| PostgreSQL | `docker-compose.yml` pins `postgres:17-alpine`. The schema uses nothing newer than Postgres 16, which ARCHITECTURE.md cites as the floor. |

No Redis, no Meilisearch, no message queue. Search is an in-process index,
sessions live in Postgres, and scheduled work is a worker loop.

---

## First run

```bash
# 1. Configuration. `.env.local` wins over `.env`; both are gitignored.
cp .env.example .env.local

# 2. At minimum, set DATABASE_URL and a SESSION_SECRET in .env.local.
openssl rand -base64 48          # paste into SESSION_SECRET

# 3. Create the schema, then the first rows.
pnpm db:migrate
pnpm db:seed

# 4. Build the content index from whatever is in content/.
pnpm content:sync

# 5. Start.
pnpm dev                          # http://localhost:3000  ·  /admin/login
```

### The admin account

`pnpm db:seed` reads three variables and creates the owner account, the
settings row and a starting navigation. It is idempotent: running it again
changes nothing, and it never resets a password or a site name an admin has
since edited.

```dotenv
ADMIN_EMAIL=you@example.com
ADMIN_NAME=Your Name
ADMIN_PASSWORD=                        # 12–1024 characters, required
```

`ADMIN_PASSWORD` is **required for a first run and is never generated**. A seed
that invents a password either writes a credential into a log or hands over an
account nobody can sign in to; refusing is the better failure. The script exits
non-zero and writes nothing if any of the three is missing or malformed — the
checks all run before the first database write, so a typo in `.env.local` cannot
produce a half-seeded database.

There is no open registration. The only way to get an account is this script or
an admin creating one.

### Content

The repository ships with 13 example documents (2 posts, 7 notes, 4 projects)
under `content/`. Point `CONTENT_DIR` somewhere else if you have your own tree
of `.md` files, or bring them in through `/admin/import` — either way
`pnpm content:sync` is what puts them in the index.

---

## Scripts

Every script below is defined in `package.json`. `db:*` and `content:*` run
through `tsx` and load `.env.local` / `.env` themselves, so they need no
wrapper.

| Script | What it does |
|--------|--------------|
| `pnpm dev` | Next.js dev server with hot reload. |
| `pnpm build` | Production build. Produces the `standalone` server bundle the Docker image copies. |
| `pnpm start` | Serves the production build (`next start`). |
| `pnpm lint` | `eslint .` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (`vitest run`). No database required. |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm test:integration` | Integration tests against a real Postgres. One file at a time. Requires `TEST_DATABASE_URL`; skips without it. |
| `pnpm test:e2e` | Playwright against a real production server (`next build && next start`) on its own database and its own content tree. Requires `TEST_DATABASE_URL`. |
| `pnpm db:generate` | `drizzle-kit generate` — writes a new SQL migration from `src/lib/db/schema.ts` into `src/lib/db/migrations/`. |
| `pnpm db:migrate` | Applies pending SQL migrations. This is what `docker compose` runs in the `migrate` service. |
| `pnpm db:seed` | Creates the owner account, settings row and default navigation. Idempotent; never generates a password. |
| `pnpm db:studio` | `drizzle-kit studio` — a browser UI over the database. |
| `pnpm content:sync` | Reconciles `content_index` against the Markdown tree by checksum (added / updated / deleted). `--check` reports without writing. |
| `pnpm content:validate` | Checks every file's frontmatter and links, writing nothing. Reports warnings and errors per file. |
| `pnpm content:reindex` | Rewrites the search documents whose `search_index_version` is behind the current one. |
| `pnpm content:import` | Importer for `--from` files, `--zip` archives and `--scan-dir` trees. A dry run unless `--apply` is passed. |
| `pnpm content:links` | Prints the links that point at nothing, grouped by the document containing them. |
| `pnpm content:stats` | Counts per type, tag and year, plus orphans, word counts and reading time — read from the index, not the files. |
| `pnpm worker` | Runs the scheduled-job loop in the foreground: `content.publish-scheduled`, `content.sync`, `content.drift-check`, `search.reindex`. Nothing starts it for you. |
| `pnpm backup` | `scripts/backup.sh` — database dump plus `content/` and `public/uploads/` archives, verified and manifested. |
| `pnpm restore` | `scripts/restore.sh` — restores a backup directory. Destructive; asks for confirmation. |

The backup and restore scripts take arguments and environment variables of their
own (`BACKUP_KEEP`, `--yes`, `--database-only`, `--files-only`); invoke them as
`bash scripts/backup.sh [dir]` and `bash scripts/restore.sh <dir> [flags]` when
you need to pass any. Both are documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Content

### Three layers

| Layer | Directory | URL | Shape |
|-------|-----------|-----|-------|
| Posts | `content/posts/` | `/posts/<slug>` | Long-form articles. A `title` is required. |
| Notes | `content/notes/` | `/notes/<slug>` | Short notes, tips, snippets, study logs. `title` is optional (derived from the first heading or line), `description` and `slug` likewise. |
| Projects | `content/projects/` | `/projects/<slug>` | Project pages. A `title` is required; `projectStatus`, `started`, `repo`, `website` and `stack` are specific to this type. |

Status is resolved rather than defaulted: an explicit `status` wins, and without
one a dated file is `published` and an undated one is `draft`. `status:
scheduled` requires `publishAt`; `status: published` requires a date. `slug`
falls back to the filename, but frontmatter wins when both are present.

All three are indexed, searchable, tagged, linked, and appear in backlinks, the
knowledge graph and the feeds.

```
content/
  posts/        ← one file = one document
  notes/
  projects/
  .locks/       ← transient; write locks
  .tmp/         ← transient; atomic-write staging
```

`content/.locks/` and `content/.tmp/` are runtime state and are gitignored. The
rest of the tree is exactly your content, nothing else — that is where revisions
were deliberately *not* put (they live in the database as gzipped snapshots; see
ARCHITECTURE.md §4).

### Frontmatter

Defined once in `src/lib/content/schema.ts` with Zod, and shared by the parser,
the validator, the CLI and the editor. Unknown keys survive a round-trip
through the admin, so hand-written frontmatter is never silently destroyed.

```yaml
---
title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "从 tcpdump 到 netstat 的一次完整排查记录"
date: 2026-09-11
updated: 2026-09-11
status: published                # draft | scheduled | published | archived
publishAt: 2026-10-01T09:00:00Z  # required when status: scheduled
tags: [Linux, Network]
category: Technology
featured: false
toc: true
lang: zh
---
```

---

## Tests

```bash
pnpm test              # unit — no database, no server
pnpm test:integration  # needs TEST_DATABASE_URL
pnpm test:e2e          # needs TEST_DATABASE_URL
```

- **Unit** (`tests/unit/`, 17 files) covers the frontmatter parser, slugs,
  the Markdown renderer, internal-link parsing, backlinks, content sync,
  redirects, path validation, search, revisions, jobs, analytics, SEO and
  settings.
- **Integration** (`tests/integration/`, 3 files) runs against real Postgres and
  a real temp content tree. `vitest.integration.config.ts` sets
  `fileParallelism: false` deliberately: every file gets its own `CONTENT_DIR`
  but they share one database, and `syncContent` deletes index rows whose file
  it cannot see — two files at once would delete each other's fixtures. Without
  `TEST_DATABASE_URL` the suites **skip**, so a checkout with no database still
  gets a green unit run.
- **End to end** (`tests/e2e/`) runs a real production server
  (`next build && next start`) against a database of its own and a temp content
  tree of its own, then drives it in Chromium — desktop and mobile profiles, one
  worker. `tests/e2e/environment.ts` explains why the suite may not touch the
  development database or `./content`: it creates documents and deletes them, so
  pointing it at the real tree would make it a data-loss tool. It derives its
  database name (`myblog_e2e`) from `TEST_DATABASE_URL` and creates it on the
  fly.

`TEST_DATABASE_URL` must point at the same Postgres server as `DATABASE_URL`
but a **different database name**. Nothing will stop you from pointing it at
your development database; the suites assume it is disposable.

```dotenv
DATABASE_URL=postgresql://myblog:…@localhost:5432/myblog
TEST_DATABASE_URL=postgresql://myblog:…@localhost:5432/myblog_test
```

---

## Where things live

```
src/
  app/
    (site)/           public reading experience — home, posts, notes, projects,
                      tags, archive, series, about, search, graph
    admin/            the CMS: dashboard, editors, assets, tags, navigation,
                      redirects, analytics, settings, system, import, login
    api/              search, assets (upload + file serving), analytics, graph,
                      preview, OG images, health
    *.ts(x)           root layout, root 404, error boundaries, sitemap, robots
  components/
    ui/               Radix + CVA primitives (shadcn-style)
    site/             reading experience
    admin/            CMS chrome and forms
    admin/editor/     CodeMirror 6 editor, metadata panel, split preview
    markdown/         renderer output and interactive block wrappers
    graph/            the knowledge graph canvas
  lib/
    content/          the only module that touches content/
    markdown/         the unified pipeline and its plugins
    db/               Drizzle schema, client, migrations
    auth/             passwords, sessions, guards, CSRF, rate limiting
    search/           SearchProvider interface + local BM25 provider
    analytics/        collection, daily aggregation, retention
    seo/              metadata, JSON-LD, feeds, OG images
    jobs/             scheduled job runner and handlers
    revision/         snapshots, diffs, restore
    assets/           uploads, image processing, blur placeholders
    security/         path jail, MIME sniffing, sanitizers
    settings/         typed site-settings accessors
    graph/            relation graph construction and layout
  env.ts              validated environment (see DEPLOYMENT.md)
  instrumentation.ts  production posture checks, run once per server start
  middleware.ts       scoped to /admin/:path*, sets x-pathname
scripts/              CLI entry points (content:*, db:*, worker) + backup/restore
tests/                unit · integration · e2e
content/              Markdown — the source of truth
public/uploads/       uploaded media
```

---

## Deployment

Docker Compose is the supported path:

```bash
docker compose up -d
```

The full runbook — the three-stage Dockerfile, the `migrate` service, every
environment variable and which are required in production, the production
posture checks, volumes, backup and restore, health checks, TLS and upgrading —
is in [DEPLOYMENT.md](./DEPLOYMENT.md).
