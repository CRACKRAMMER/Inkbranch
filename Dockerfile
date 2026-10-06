# syntax=docker/dockerfile:1.7
#
# Three stages, and the shape is chosen for two properties.
#
# **The runtime image contains only traced runtime dependencies.** The
# build produces a standalone server bundle, and the final stage copies that
# bundle plus the static assets. What ships is the application and its traced
# dependencies. Corepack remains in the Node base image; no full pnpm install
# or development dependency tree is copied into the runtime stage.
#
# **The content is not in the image.** `content/` and `public/uploads/` are
# volumes. The image is the application, and the application is byte-identical
# whatever is published with it, which is what makes a rollback a tag change
# rather than a restore.

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base

# `libc6-compat` is what `sharp` and `@node-rs/argon2` need on musl; both ship
# prebuilt binaries for it. Without this the image builds and then fails at the
# first image resize or the first login.
RUN apk add --no-cache libc6-compat

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

# `corepack` reads `packageManager` from package.json, so the pnpm version in
# the image is the one pinned in the repository rather than one written here
# that would drift from it.
RUN corepack enable

WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

FROM base AS deps

# Only the manifests, so this layer is rebuilt when — and only when — the
# dependency set changes. Editing a source file does not re-run the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `--frozen-lockfile` fails rather than resolving anything new: a lockfile that
# does not match package.json is a build that would produce an image nobody
# tested. The cache mount keeps the store between builds without it ending up
# in a layer.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# A build needs *a* value for the required env vars, because `src/env.ts`
# validates at import time and refuses to load without them — but it must not
# need the *real* ones. Nothing here is baked into the output: the variables
# are read at run time from the environment, and these placeholders only exist
# to get the compiler past module evaluation.
#
# The SESSION_SECRET is a fixed dummy. It avoids introducing a real credential
# into image layers; this does not promise byte-identical framework builds.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
ENV SESSION_SECRET=build-time-placeholder-not-used-at-run-time-000000
# The build must not reach for a database or a content directory. Every route
# that reads either is marked dynamic; this makes the intent explicit.
ENV CONTENT_SYNC_ON_BOOT=0

RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Unprivileged, and created rather than borrowed from a base image's user so
# the uid is the same on every platform. Bind mounts retain their host ownership;
# the operator must grant uid 1001 write access before starting Compose.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# The server bundle, which already contains the traced `node_modules` it needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets are not part of the standalone output; the server expects them
# at `.next/static` relative to itself.
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# Fonts, icons, and anything else under `public/`. Uploads land in a subdirectory
# of this and are overlaid by a volume, so the directory must exist and be
# writable before the mount happens.
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Migrations are deliberately *not* runnable from this stage. The migrator is
# TypeScript and runs under `tsx`, which is a dev dependency, and the standalone
# bundle is traced from the app's entry points — it does not contain either.
# Copying `src/`, `scripts/` and `drizzle/` in here would look like it worked
# and fail the first time anyone tried it.
#
# Instead `docker-compose.yml` runs migrations from the `build` stage, which has
# the full toolchain and the same lockfile. That service and this one are built
# from the same commit, so the schema and the code are never a version apart.

# Where content and uploads live, so a volume can be mounted and the defaults
# in `src/env.ts` do not have to be overridden.
RUN mkdir -p /app/content /app/public/uploads \
 && chown -R nextjs:nodejs /app/content /app/public/uploads

USER nextjs

EXPOSE 3000

# The health route reports database reachability as well as process liveness,
# so a container whose database has gone away leaves the load balancer instead
# of serving errors. `node` rather than `curl`, because the runtime image has
# no HTTP client and adding one to run a health check is a poor trade.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
