# Deployment

[简体中文](./DEPLOYMENT.zh-CN.md)

Docker Compose on a single host. The application is one Node process, its
database is one Postgres, and everything it serves that is not code lives in two
directories you can open. There is nothing else to install: search is
in-process, sessions are rows in Postgres, and the job queue is a table.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first if you want to know *why* the
system is shaped this way; this document is the runbook.

---

## 1. The supported path

```bash
git clone <repo> inkbranch && cd inkbranch
cp .env.example .env             # compose reads .env, not .env.local
$EDITOR .env                     # set POSTGRES_PASSWORD, SESSION_SECRET, HTTPS SITE_URL, COOKIE_SECURE=1
mkdir -p content uploads
sudo chown -R 1001:1001 content uploads   # see §6 — a bind mount keeps host ownership
docker compose up -d
```

`docker compose up -d` starts three services:

| Service | Image | Role |
|---------|-------|------|
| `postgres` | `postgres:17-alpine` | The database. PostgreSQL 17 is the supported and tested deployment version. |
| `migrate` | this repo, `build` stage | Applies pending migrations and exits. |
| `web` | this repo, `runner` stage | The site. Starts only after `migrate` exits 0. |

A fourth service, `reverse-proxy`, is behind a compose profile and does not start
unless it is asked for:

```bash
echo 'DOMAIN=blog.example.com' >> .env    # the hostname readers use
docker compose --profile proxy up -d
```

That puts Caddy in front, which obtains and renews a certificate for `DOMAIN` and
is then the only way into `web` — see §9.

Compose reads these from `.env` (the file compose loads, which is *not*
`.env.local` — that is the one the application and the CLI scripts load):

| Variable | Required | Notes |
|----------|----------|-------|
| `POSTGRES_PASSWORD` | yes | Compose refuses to start without it (`:?` in `docker-compose.yml`). |
| `SESSION_SECRET` | yes | Passed to both `migrate` and `web`. |
| `SITE_URL` | yes in production | Must be `https://…`; see §5. |
| `COOKIE_SECURE` | yes in production | Must be `1`; see §5. |
| `DOMAIN` | yes with the `proxy` profile | Must be the hostname in `SITE_URL`, or sign-in and saves are refused as cross-origin. Defaults to `localhost`, which Caddy serves with its own internal CA. |
| `POSTGRES_USER` / `POSTGRES_DB` / `PORT` | no | Default to `myblog`, `myblog`, `3000`. |

Then seed the owner account — once, by hand, because it needs a password from a
human and is deliberately not part of `docker compose up` (§4):

```bash
# Run it in a container built at the `build` stage, which has tsx and scripts/.
docker compose run --rm \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME='Your Name' -e ADMIN_PASSWORD='…' \
  migrate pnpm db:seed
```

`migrate` is the service built at the `build` stage, so it is the one that can
run `pnpm db:seed` — `docker compose run` overrides its command while keeping its
environment and its `depends_on`. The `web` container cannot: the runtime image
has no `tsx` and no `scripts/` (§2). Running the seed from a checkout against the
same database works identically.

### What is not in the compose file, and why

No Redis, no Meilisearch, no separate worker container. Search is an in-process
index and sessions are in Postgres, so a cache service would have nothing to
cache that is not already local, and scheduled work is a worker loop inside
`web` (`WORKER_ENABLED`, §10).

The `reverse-proxy` service is a profile rather than a given because TLS
termination is a decision about *your* host. If you already run nginx or Caddy on
the host, leave the profile off and point that proxy at `127.0.0.1:3000` — §9
lists what it has to do. If you do not have one, the profile is a complete
answer: `docker compose --profile proxy up -d` obtains a certificate for
`DOMAIN` and renews it without a certbot timer to forget.

The database port is **not** published to the host by default. Uncomment the
`ports:` block in `docker-compose.yml` if you want `psql` from the host; leaving
it closed means Postgres is reachable only from the compose network.

---

## 2. The image

`Dockerfile` has four `FROM` lines: a shared `base` (Node 22 Alpine, `libc6-compat`
for `sharp` and `@node-rs/argon2`, Corepack enabled so the pnpm version comes
from `packageManager` in `package.json`), then three working stages over it.

| Stage | Produces | Key properties |
|-------|----------|----------------|
| `deps` | `node_modules` | Copies `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, so editing a source file does not re-run the install. `--frozen-lockfile` fails rather than resolving anything new. |
| `build` | `.next/` | Copies the source and builds with **placeholder** environment values (`DATABASE_URL`, a fixed dummy `SESSION_SECRET`, `CONTENT_SYNC_ON_BOOT=0`) because `src/env.ts` validates at import. Runtime credentials and the site origin are supplied when starting the container; no real credentials are required by the build. Next.js builds are not guaranteed to be byte-identical. |
| `runner` | the server | `NODE_ENV=production`, `PORT=3000`, non-root user `nextjs` (uid 1001), the standalone bundle plus `.next/static` plus `public/`. |

Three things about the runtime stage are load-bearing.

**It contains traced runtime dependencies, rather than the full development dependency tree.** `next.config.ts`
sets `output: 'standalone'`, so the build emits a server bundle containing only
the modules the application actually reached. What ships is the application and
its traced dependencies, including a standalone `node_modules` directory. (The
base stage does enable Corepack, so a `pnpm` shim exists on `PATH`; invoking it
would try to download pnpm, and there is no dependency tree for it to install
into.)

**`public/` and `.next/static/` are copied by hand.** They are not part of the
standalone output — this is the one consequence of `output: 'standalone'` worth
knowing, and forgetting it produces a site with no CSS.

**`/app/content` and `/app/public/uploads` are created and chowned in the
image** so that the volumes in §6 can be mounted over them.

The image carries a `HEALTHCHECK` that polls `/api/health` with `node -e` rather
than `curl`, because the runtime image has no HTTP client and adding one to run
a health check is a poor trade.

---

## 3. Migrations

Migrations are SQL files under `src/lib/db/migrations/`, generated by
`pnpm db:generate` and applied by `src/lib/db/migrate.ts`. In Compose they run in
their own service:

```yaml
migrate:
  build: { context: ., target: build }
  command: ['pnpm', 'db:migrate']
  depends_on: { postgres: { condition: service_healthy } }
  restart: 'no'
```

and `web` waits on `service_completed_successfully`, so a deploy can never serve
a schema it does not match.

**Why migrations do not run in the runtime image.** The migrator is TypeScript
and runs under `tsx`, which is a devDependency; the standalone bundle is traced
from the application's entry points and contains neither `tsx` nor `scripts/`.
Copying `src/`, `scripts/` and `drizzle/` into the runner stage would *look* like
it worked and fail the first time anyone tried it. The `migrate` service builds
the same commit at the `build` stage instead, which has the full toolchain and
the same lockfile — so the schema and the code are never a version apart.

The database URL used by that service is assembled from `POSTGRES_*`; it does not use `DATABASE_URL` from `.env`. Generate `POSTGRES_PASSWORD` with `openssl rand -hex 32` so it contains no URL delimiters. Migrations hold their advisory lock, transaction and unlock on one dedicated PostgreSQL connection.

Manual equivalent, from a checkout:

```bash
pnpm db:migrate        # applies pending migrations, prints how many
```

Migrations are forward-only. Take a backup before an upgrade (§7).

---

## 4. Environment variables

Every variable the application reads is declared once in `src/env.ts` and
validated at import. `.env.example` documents the same set with commentary.

### Application

| Variable | Default | Required in production | What it does |
|----------|---------|:---:|--------------|
| `NODE_ENV` | `development` | — | Set to `production` by the image. Selects the posture checks in §5. |
| `DATABASE_URL` | — | **yes** | `postgres://` or `postgresql://`. Validated at import; the app will not start without it. |
| `DATABASE_POOL_MAX` | `10` | no | Connection pool ceiling. |
| `SESSION_SECRET` | — | **yes** | At least 32 characters. `openssl rand -base64 48`. Also refused if it is the development default. |
| `SESSION_COOKIE_NAME` | `myblog_session` | no | Only change it if several instances share a host. |
| `SESSION_ABSOLUTE_TTL` | `2592000` (30 d) | no | Seconds. |
| `SESSION_IDLE_TTL` | `604800` (7 d) | no | Seconds. |
| `COOKIE_SECURE` | `0` | **yes (=1)** | Adds `Secure` to cookies. Refused as `0` in production. |
| `SITE_URL` | `http://localhost:3000` | **yes (https)** | Canonical URLs, sitemap, feeds, OG cards, and the CSRF origin allow-list. Must be the address a reader types. |
| `TRUSTED_ORIGINS` | `localhost:3000` | no | Comma-separated extra hostnames accepted as request origins. `SITE_URL`'s host is always added, so this is only needed for an alias domain. |
| `CONTENT_DIR` | `./content` | no | Root of the Markdown tree. `/app/content` in the image. |
| `CONTENT_MAX_FILES` | `5000` | no | Guards against a mis-mounted volume turning boot into a filesystem walk of `/`. |
| `CONTENT_SYNC_ON_BOOT` | `1` | no | Makes the enabled worker's first drift check immediate. At `0` it waits one interval; this does not disable later syncs. A read-only content mount requires `WORKER_ENABLED=0` and a separately prepared index. The Docker **build** sets it to 0. |
| `SEARCH_PROVIDER` | `local` | no | An enum with one value today; the seam Meilisearch would slot into. Not in `.env.example`. |
| `UPLOAD_DIR` | `./public/uploads` | no | `/app/public/uploads` in the image, which is where the `./uploads` bind mount lands. |
| `UPLOAD_URL_PREFIX` | `/uploads` | no | Public URL prefix that maps to `UPLOAD_DIR`. Must start with `/`. |
| `MAX_UPLOAD_SIZE` | `20971520` (20 MiB) | no | Per-file upload ceiling. Your reverse proxy needs its own limit set at least this high (§9). |
| `ANALYTICS_ENABLED` | `1` | no | `0` disables collection entirely (the collector stops writing). |
| `ANALYTICS_RAW_RETENTION_DAYS` | `30` | no | How long raw events are kept before aggregation-only retention. |
| `GIT_INTEGRATION_ENABLED` | `0` | no | Permission for content auto-commit. The settings say whether the site wants commits, this says whether the process may make them, and the feature needs both — see §10. Off by default: a deployment that changed nothing runs no `git` process at all. |
| `WORKER_ENABLED` | `1` | no | Starts the worker inside the server process; see §10. |
| `WORKER_INTERVAL_MS` | `60000` | no | Interval between worker maintenance sweeps; claims poll between sweeps. |
| `JOB_RETENTION_DAYS` | `7` | no | Retention for completed and failed job rows. |
| `TEST_DATABASE_URL` | — | no | Read only by the test suites, never by the app. |

### Read by tooling, not by the application

| Variable | Used by | Notes |
|----------|---------|-------|
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | `pnpm db:seed` only | The app never holds the owner's password. `ADMIN_PASSWORD` is 12–1024 characters and is **never generated** — the seed exits non-zero rather than inventing one. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `docker-compose.yml` | `POSTGRES_PASSWORD` is mandatory; the others default. |
| `PORT` | compose, image | Host port for the `web` service, published on loopback only; `3000` inside the container. |
| `BACKUP_KEEP` | `scripts/backup.sh` | Backups to retain. Default 14; `0` disables pruning. |
| `E2E_PORT`, `E2E_BASE_URL` | `playwright.config.ts` | Only for the test suite. |
| `NEXT_TELEMETRY_DISABLED` | set to `1` in the image | Standard Next.js flag. |

Every variable is validated for **shape** at import: types, required-ness,
allowed values, with a default for everything that has one. Boolean values must be `0`, `1`, `true` or `false`; unknown spellings are rejected. Database URLs must identify a PostgreSQL host and database, and the site URL must use HTTP(S) without credentials. `DATABASE_URL` and
`SESSION_SECRET` have no default and are therefore hard requirements wherever
the module is loaded — including inside a CLI script. Three variables are
additionally checked for **posture** in production, which is §5.

---

## 5. Production posture checks

Three settings are silently void rather than visibly broken when they are wrong,
so the application refuses to serve with any of them:

```ts
// src/env.ts
export function assertProductionPosture(): void {
  if (env.NODE_ENV !== 'production') return
  // throws on: the development SESSION_SECRET,
  //            COOKIE_SECURE != 1,
  //            SITE_URL starting with http://
}
```

It is called from `src/instrumentation.ts`, which Next.js runs **once per server
process, before the first request — and not during `next build`**. That split is
deliberate: `next build` forces `NODE_ENV=production` and imports every route to
collect page data, so checking posture at import time would mean a build could
only succeed on a machine already configured like a live server. The shape
checks stay at import (a missing `DATABASE_URL` is a bug anywhere); the posture
checks run where the values actually matter. `register()` returns early unless
`NEXT_RUNTIME === 'nodejs'`, since the edge runtime reads none of these.

| Refused | Message | Fix |
|---------|---------|-----|
| `SESSION_SECRET` is the development default | `SESSION_SECRET is still the development default.` | `openssl rand -base64 48` |
| `COOKIE_SECURE=0` (or unset) | `COOKIE_SECURE must be 1 in production…` | Terminate TLS and set `1` |
| `SITE_URL` starts with `http://` | `SITE_URL must use https:// in production.` | Set the public `https://` origin |

The failure is fatal and loud: a configuration that should have been refused
takes the process down instead of being served from. A container that exits
immediately after `migrate` completes with one of these messages is working
exactly as designed.

---

## 6. Volumes

| Host path | Container path | Mode | Contents |
|-----------|----------------|------|----------|
| `./content` | `/app/content` | read-write | The Markdown — the source of truth. |
| `./uploads` | `/app/public/uploads` | read-write | Uploaded media. |
| `postgres-data` (named) | `/var/lib/postgresql/data` | — | The database. |
| `caddy-data`, `caddy-config` (named) | `/data`, `/config` | — | Certificates, with the `proxy` profile. |

Both application volumes are **bind mounts, not named volumes**, and that is the
point: Markdown is meant to be edited on the host — in an editor, in git, over
SSH — so it has to be a directory you can open rather than a blob Docker manages.
Uploads are the same: the files are meant to be reachable, copyable, and picked
up by the same backup script that picks up the Markdown.

The host and container paths differ. A local `pnpm dev` writes to
`public/uploads/`; Compose mounts the host's `uploads/` at the equivalent
container path. Requests to `/uploads/**` are rewritten to the sandboxed asset
route, which applies the same file validation and response headers as
`/api/assets/**`.

Consequences worth knowing:

- **A bind mount keeps the host's ownership.** The container runs as uid 1001
  (`nextjs`), so both directories must be writable by that uid or admin saves and
  uploads fail with `EACCES`. On a fresh host:
  `sudo chown -R 1001:1001 content uploads`. Docker creates a *missing*
  bind-mount source as `root`, which is why `mkdir -p content uploads` and the
  `chown` belong before the first `up`.
- **Editing on the host needs a sync.** The app reconciles at boot and after
  every admin save. If you edit files while it is running and do not want to
  restart, run `pnpm content:sync` (§11).
- **The image contains no content.** That is what makes a rollback a tag change
  rather than a restore — the same image serves whatever is mounted.

---

## 7. Backup and restore

Stop `web`, any separate worker, and external content edits while taking a coherent snapshot. The database and filesystem cannot be snapshotted together by these scripts while writers continue running.

The host needs Bash, GNU `tar`/`realpath`/`find`, `flock`, `zstd`, and PostgreSQL 17 client tools. Its `DATABASE_URL` must reach the same database as Compose; the default Compose network does not expose Postgres to the host. Publish the database on **loopback only** if using host clients, or run the clients inside the Compose network. Set `CONTENT_DIR` and `UPLOAD_DIR` to host paths when running the scripts on the host; Compose data is `./content` and `./uploads`, whereas local development uploads are `./public/uploads`.

```bash
# The scripts read exported values, then .env.local, then .env.
# Configure a host-accessible DATABASE_URL before this step.
CONTENT_DIR=./content UPLOAD_DIR=./uploads bash scripts/backup.sh
BACKUP_KEEP=30 bash scripts/backup.sh /mnt/backups
BACKUP_LABEL=pre-upgrade bash scripts/backup.sh
```

A verified `backup-<UTC date>[-label][-suffix].tar.zst` contains:

```
database.dump        custom-format pg_dump
content/             Markdown snapshot, excluding runtime .locks/ and .tmp/
uploads/             media snapshot
config/              .env and .env.local, when present
MANIFEST             version, original paths, timestamp and redacted database URL
```

The content snapshot includes private `.recovery/` copies from interrupted
formal mutations. They retain exact previous file bytes, including unpublished
content, with file mode 0600 and directory mode 0700. The Admin error or worker
log names the relative recovery file. Pause writers, preserve both the current
document and that snapshot, compare them, then deliberately restore the desired
bytes to the reported document path and run `pnpm content:sync` followed by
`pnpm content:sync --check`. A sync repairs the index but does not turn the copy
into a revision. Remove a retained snapshot only after verifying recovery and
backup; retries and normal retention never automatically remove earlier failures.

Version 2 uses stable `content` and `uploads` member names even for custom source paths. Missing directories and symlinks are refused. Data trees are staged before archiving; allow disk space for the staged data and the final compressed archive. PAX tar preserves fractional modification times. Secret-bearing staging and archive files are private (`umask 077`); protect the archive like `.env` because it also contains password hashes, session state and revision history.

The script verifies the compressed stream, tar members and `pg_restore --list` before publishing the final filename. Same-day backups receive a free numeric suffix, backup operations in the same destination are exclusively locked, and retention uses file modification time rather than lexical filename order. `BACKUP_KEEP=0` disables pruning. Labels permit only letters, digits, underscores and hyphens.

```bash
bash scripts/restore.sh backups/backup-<date>.tar.zst
bash scripts/restore.sh <archive> --yes
bash scripts/restore.sh <archive> --database-only
bash scripts/restore.sh <archive> --files-only
```

Restore verifies checksums, member names, file types, duplicate members, the manifest and database archive before replacing data. Links, traversal paths, special files, unexpected members, symlinked targets and overlapping data roots are rejected. Legacy archives produced by the previous script remain supported when they meet these checks.

Files are extracted completely into private staging directories before any swap. Current trees move to `*.before-<UTC timestamp>`, and restored trees replace them rather than merging. Environment copies land in `config.restored/`; live `.env` files are preserved. Database restore uses `--clean --if-exists --single-transaction --exit-on-error`. If it fails, the database transaction rolls back and the script rolls the file/config swaps back as well. Staged data preserves each existing target directory's owner, so Compose's uid 1001 retains write access; a caller lacking permission to preserve it fails before replacing files. Run restore with the required host ownership privileges. If targets were absent, set their ownership for the application before restart (`sudo chown -R 1001:1001 content uploads` for the shipped rootful Docker setup). Successful restores keep previous trees for manual recovery. A restore is exclusively locked per checkout.

The confirmation displays the database and file targets even with `--yes`, and warns if exported `DATABASE_URL` differs from dotenv. Keep all writers stopped until restore and reconciliation complete:

```bash
pnpm content:sync
pnpm content:sync --check
```

Then restart the application and compare `config.restored/` with the live environment. Preserve the archive and `*.before-*` trees until the recovered site has been verified. An abrupt host shutdown during the cross-resource restore cannot run the rollback trap; use those preserved trees and the archive for recovery before restarting writers.

---

## 8. Health check

```
GET /api/health
```

```json
{
  "status": "ok",
  "database": { "ok": true, "latencyMs": 3 },
  "contentIndex": { "ok": true, "drift": false, "scanned": 12, "indexed": 12 }
}
```

| `status` | HTTP | Meaning |
|----------|:---:|---------|
| `ok` | 200 | Database answering, index matches the files. |
| `degraded` | 200 | Database fine, but the content index disagrees with the tree. |
| `unavailable` | 503 | The database is not answering. |

Two questions and nothing else. Drift is **not** a 503 on purpose: the pages
still render, and the thing that fixes drift is a sync, not a restart — returning
503 would put a working container into a restart loop that cannot help. The
endpoint is public because a healthcheck cannot hold a session, so it is written
to say nothing an operator would not publish: no environment dump, no version,
no connection details, no filesystem paths, and never the driver's own error
message (which can name a host, a user or a socket — that goes to the container
log instead). Responses are `no-store`.

```bash
curl -fsS https://blog.example.com/api/health
docker inspect --format '{{.State.Health.Status}}' myblog-web-1
```

The image ships a `HEALTHCHECK` with a 20-second start period, 30-second
interval, 5-second timeout and 3 retries. Raise the start period if your host is
slow and the first boot-time content sync is large.

---

## 9. Reverse proxy and TLS

The container serves plain HTTP on port 3000 and **must** sit behind a proxy that
terminates TLS, because production requires `SITE_URL` to be `https://` and
`COOKIE_SECURE=1`. Minimum viable configuration:

1. Bind the app to loopback so it is not reachable directly:
   `ports: ['127.0.0.1:3000:3000']`.
2. Forward the standard headers — `Host`, `X-Forwarded-Proto`, `X-Forwarded-For`.
3. Set `client_max_body_size` (nginx) or the equivalent at least as high as
   `MAX_UPLOAD_SIZE` (20 MiB by default). A proxy default of 1 MiB produces a 413
   on every image upload and no application log line to explain it.
4. Do not set headers the application sets itself. The CSP, `X-Content-Type-Options`,
   `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` come from
   `next.config.ts`; a proxy rule that sets them too will silently override the
   app's values, and `/api/assets` in particular has a narrower CSP for uploaded
   SVG that must not be replaced.
5. Send HSTS from the proxy — the application does not.

The edge proxy must overwrite client-supplied `X-Forwarded-For` with the actual connection address. Authentication rate limiting trusts the first forwarded address (hashed for limiter keys; analytics does not read it), so multiple proxy hops require an explicit trusted-proxy and header-overwrite configuration.

```nginx
server {
  listen 443 ssl;
  server_name blog.example.com;

  ssl_certificate     /etc/letsencrypt/live/blog.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/blog.example.com/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Caddy does the same with fewer lines and gets certificates automatically:

```
blog.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then set `SITE_URL=https://blog.example.com`, `COOKIE_SECURE=1` and restart.

The site's own origin checks compare the browser's `Origin` against the host in
`SITE_URL` plus `TRUSTED_ORIGINS`, so **`SITE_URL` must be the hostname readers
use**. If the site is reachable at more than one hostname (apex and `www`, or a
staging alias), list the extras in `TRUSTED_ORIGINS` — otherwise sign-in and
admin saves are refused as cross-origin.

---

## 10. Operating

### The worker

`src/instrumentation.ts` starts the embedded worker when `WORKER_ENABLED=1`, including in the standalone Compose server. It handles scheduled publishing, content sync/drift checks, search reindexing, analytics aggregation/retention, asset reference scans, and expired authentication records. The worker retries database startup with backoff and logs one JSON object per line.

`pnpm worker` runs the same loop in a separate process and ignores `WORKER_ENABLED`. It needs the repository's TypeScript toolchain, so use the `build` stage or a host checkout rather than the `runner` image. The CLI finishes its current job on the first `SIGINT`/`SIGTERM`; a second signal forces exit.

Queue claims use `FOR UPDATE SKIP LOCKED` and a 15-minute lease. An abrupt server restart can leave a claim until its lease expires; handlers reconcile from source files and scheduled publication rechecks the file under its write lock, making repeated execution safe. Failed and incomplete sync/publish jobs are recorded as failures and retried, rather than marked done. Due scheduled content is also visible through the read path while bookkeeping catches up.

Set `WORKER_ENABLED=0` only when another worker maintains the same database and content tree. `CONTENT_SYNC_ON_BOOT=0` disables the boot reconciliation check; it does not disable the worker's subsequent cadence.

### Content that arrives without the admin

A `git pull`, an SSH edit or a file dropped into `content/` is a supported way to
publish. The app reconciles at boot, so a restart is always sufficient. Without
a restart:

```bash
pnpm content:sync        # full reconcile, verbose
pnpm content:sync --check # is the index out of sync? writes nothing
```

### Committing the content directory to git

The other direction: `src/lib/git/` can commit what the admin writes, so the
Markdown tree accumulates a history of its own. Two switches have to agree —
Settings → Git (**Git integration** plus **Commit content changes
automatically**) and `GIT_INTEGRATION_ENABLED=1` in the app's environment. Set
the settings and leave the flag at `0` and the editor says so after every save,
by design: a switch that does nothing quietly is worse than one that explains
itself. Both default to off.

Turning it on needs three things the shipped image does not provide:

- **`git` in the image.** The `runner` stage installs `libc6-compat` and nothing
  else. Add `git` to the `apk add` line in the `base` stage, or run the app
  outside a container. Without it every save reports "git is not installed on the
  server" and the file is written anyway.
- **A repository the process can write.** Either the site repository itself —
  `/app/content` is inside it — or one created inside the volume: `git init` in
  `/app/content`. A bind mount or volume must let uid 1001 write `.git/`.
- **An identity.** `git config user.name` and `user.email`, globally or in that
  repository. Without one, commits are refused and reported as
  `no-identity` rather than failing a save.

Operationally:

- One commit per save, deletion and revision restore; one for a bulk or tag
  operation however many documents it touched.
- Messages come from the settings template — `content: update "Linux Network
  Debugging"` by default.
- Only the files that operation changed are staged. Anything you have staged
  yourself is left alone.
- **It never pushes.** The subcommand allow-list in `src/lib/git/index.ts` has no
  remote on it; a deploy is still `git push` from wherever you keep the origin.
- A commit that fails is logged and shown in the editor. It never fails a save:
  the file is written first.

The unit and integration suites run with `GIT_INTEGRATION_ENABLED=0`, so nothing
there reaches a repository. The E2E suite runs with it on, against a repository
`global-setup.ts` creates inside the throwaway content tree and leaves with no
commits in it: `tests/e2e/git.spec.ts` turns auto-commit on, saves, checks the
repository and the editor's report of it, and turns the settings off again —
including when it fails. Every other spec in that run leaves the settings off
and commits nothing, which is what the suite's repository is a check on.

### Upgrading

```bash
pnpm backup                       # always; migrations are forward-only
git pull
docker compose build
docker compose up -d              # migrate runs first, then web
```

`docker compose up -d` recreates only what changed, and `web` waits for `migrate`
to exit successfully. The content tree is a volume and is untouched by a deploy,
so a rollback is: check out the previous commit, `docker compose build`,
`docker compose up -d`. Take the backup anyway — a migration that drops a column
is not undone by an older image.

### Limitations worth knowing before you scale

- **One application instance is the design point.** The search index is built
  in-process from the content files, keyed on a fingerprint of the tree with a
  five-second time to live, so a second replica would build its own copy and
  converge within seconds — but nothing coordinates the two, and
  `revalidateContentChange` runs in whichever process handled the save. There is
  no shared cache or queue either.
- **Analytics intentionally avoids IP addresses and geolocation.** Page-view beacons and the worker's daily aggregation are wired end to end. Country remains empty; no country lookup is performed. Disabling collection prevents new tracking rows.
- **Stored redirects are served by the Node proxy.** Only GET/HEAD requests on permitted paths are redirected; reserved application paths and invalid or looping rules are refused.
- **Git auto-commit commits within one process.** Two app instances writing to
  one repository, or a save overlapping `pnpm content:sync` in a terminal, can
  contend for `.git/index.lock`; the loser's commit is logged and skipped, and
  the next save commits the file. Nothing is lost from the files themselves, and
  nothing here pushes.
- **Backup/restore requires a maintenance window.** Pause the server, worker and external edits for a coherent database/file snapshot; restore and reconcile before restarting them.
- **No editorial permissions workflow.** Accounts can be provisioned through the seed CLI, but the current admin requires authentication rather than separate role permissions.

---

## 11. Troubleshooting

**The container exits immediately, and the log names one of the posture checks.**
Working as designed — see §5. A development `SESSION_SECRET`, `COOKIE_SECURE`
not set to `1`, or an `http://` `SITE_URL` are all fatal in production.

**`Invalid environment configuration: - DATABASE_URL: …`** at boot, from any
process including `pnpm db:migrate`. The variable is missing or is not a
`postgres://` string. Note that a script run under `tsx` loads `.env.local` then
`.env`, in that order, and does not expand `${VAR}`.

**`/api/health` reports `unavailable` (503).** The database is not answering.
Check `docker compose ps` — if `postgres` is unhealthy, `web` never started.
`docker compose logs postgres`. The health endpoint deliberately does not tell
you *why*; the reason is in the app's log line (`[health] database check failed`).

**`/api/health` reports `degraded`.** The index and the files disagree — usually
after a restore, a `git pull` without a restart, or a bind mount that was edited
on the host. Run `pnpm content:sync`. It is not an error status on purpose
(§8).

**The site loads but every page is empty, or the admin lists nothing.** Almost
always `CONTENT_DIR` pointing somewhere empty, or `content/` not mounted.
`docker compose exec web ls /app/content`. Then `pnpm content:sync`.

**Signing in appears to succeed and immediately returns to the login page.** The
`Secure` cookie was refused or dropped: the site is being served over plain HTTP,
or the browser sees a different host than `SITE_URL` names. Terminate TLS and set
`COOKIE_SECURE=1` (§9). Do not "fix" this by setting `COOKIE_SECURE=0` in
production — it is refused at startup, and overriding it means session cookies
travel in clear text.

**Admin saves or uploads fail with `EACCES` / a permission error.** The bind
mounted directories are not writable by uid 1001. `sudo chown -R 1001:1001 content uploads`.

**Uploads fail with 413 and nothing appears in the application log.** The reverse
proxy's request body limit. Raise `client_max_body_size` to at least
`MAX_UPLOAD_SIZE` (§9).

**`migrate` exits non-zero and `web` never starts.** The migration failed; the
database URL is assembled from `POSTGRES_*` in `docker-compose.yml`, and the
error is in `docker compose logs migrate`. Common causes: the role lacks
`CREATE`/`ALTER`, or a migration was hand-edited after being applied.

**A redirect you saved does not fire.** Check that the rule is enabled and its source is a permitted public path. The Node proxy resolves rules before routing; reserved routes, non-GET/HEAD methods and invalid/looping destinations are excluded.

**Analytics shows zero, or numbers stopped moving.** Both `ANALYTICS_ENABLED=1` and the site's analytics setting are required. Verify `worker.start` and `job.analytics-aggregate` logs, inspect failed jobs in `/admin/system`, and allow the aggregation cadence to run. Browser requests with rejected origins or privacy opt-outs are intentionally discarded.

**Search returns results that are out of date after a save.** The index is
in-process and invalidated on every admin save by `revalidateContentChange`, so
this should not persist. If it does, you are probably running more than one
instance (§10).

**Boot takes a long time on a large tree.** The boot-time sync is lightweight
(mtime and size, no hashing) but it still walks `CONTENT_DIR`. Set
`CONTENT_SYNC_ON_BOOT=0` and reconcile explicitly, or raise the healthcheck's
start period.
