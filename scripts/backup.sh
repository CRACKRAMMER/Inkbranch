#!/usr/bin/env bash
#
# Back up everything this site cannot regenerate.
#
# ## What is in a backup, and what is not
#
# Three things are irreplaceable: the database (index, sessions, tags,
# revisions, audit log, analytics), `content/` (the Markdown, which is the
# source of truth), and `public/uploads/` (the media, which the Markdown points
# at). All three are here.
#
# Nothing else is. `.next/`, `node_modules/` and the built image are all
# reproducible from the source, and including them would multiply the size of
# every backup by a hundred for nothing.
#
# ## Why the content tree is archived even though it is the source of truth
#
# The Markdown is *the* source of truth and the database is derived — which
# naively suggests the database does not need backing up at all. It does. The
# index is derived, but revisions, sessions, the audit log and the analytics
# rollups are not, and there is no way to rebuild a revision history from files
# that have already been overwritten.
#
# ## The layout
#
#   backups/<timestamp>/
#     database.dump        pg_dump, custom format (compressed, restorable in parts)
#     content.tar.gz       the Markdown tree
#     uploads.tar.gz       the media tree
#     MANIFEST             what this is, from where, and whether it verified
#
# Usage:
#   scripts/backup.sh                 # writes to ./backups/<timestamp>
#   scripts/backup.sh /mnt/backups    # writes elsewhere
#
# Environment:
#   DATABASE_URL   required; read from .env.local if it is not already set
#   BACKUP_KEEP    how many backups to retain (default 14, 0 disables pruning)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BACKUP_ROOT="${1:-$REPO_ROOT/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

CONTENT_DIR="${CONTENT_DIR:-$REPO_ROOT/content}"
UPLOAD_DIR="${UPLOAD_DIR:-$REPO_ROOT/public/uploads}"

# Read `DATABASE_URL` from `.env.local` when the caller has not already set it.
# Deliberately not `source`: the file may contain values with characters the
# shell would interpret, and only one variable is wanted.
if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.local" | head -1 | cut -d= -f2-)"
  DATABASE_URL="${DATABASE_URL%\"}"
  DATABASE_URL="${DATABASE_URL#\"}"
  export DATABASE_URL
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set and could not be read from .env.local" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found. Install postgresql-client, or run this" >&2
  echo "       inside the compose network with:" >&2
  echo "       docker compose exec postgres pg_dump ..." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

# `%Y-%m-%dT%H-%M-%SZ` — UTC, lexically sortable, and free of the colons that
# some filesystems reject. A timestamp that sorts wrong is a timestamp that
# makes "the backup from just before the incident" hard to find.
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$BACKUP_ROOT/$STAMP"

echo "Backing up to $DEST"
mkdir -p "$DEST"

# Fail rather than silently writing a partial dump. `pg_dump` writes to stdout;
# `set -o pipefail` is already in effect, and the explicit check below catches a
# dump that exits zero having written nothing useful.
echo "  database…"
pg_dump \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$DEST/database.dump" \
  "$DATABASE_URL"

if [[ ! -s "$DEST/database.dump" ]]; then
  echo "error: pg_dump produced an empty file" >&2
  exit 1
fi

echo "  content…"
if [[ -d "$CONTENT_DIR" ]]; then
  # `--one-file-system` so a symlink out of the content tree cannot pull an
  # unrelated mount into the archive.
  tar --create --gzip --file="$DEST/content.tar.gz" \
      --one-file-system \
      --directory="$(dirname "$CONTENT_DIR")" "$(basename "$CONTENT_DIR")"
else
  echo "    (no content directory at $CONTENT_DIR — writing an empty archive)"
  tar --create --gzip --file="$DEST/content.tar.gz" --files-from=/dev/null
fi

echo "  uploads…"
if [[ -d "$UPLOAD_DIR" ]]; then
  tar --create --gzip --file="$DEST/uploads.tar.gz" \
      --one-file-system \
      --directory="$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")"
else
  echo "    (no uploads directory at $UPLOAD_DIR — writing an empty archive)"
  tar --create --gzip --file="$DEST/uploads.tar.gz" --files-from=/dev/null
fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

# A backup nobody has read back is a hope, not a backup. `pg_restore --list`
# parses the archive's table of contents, which catches truncation and a
# half-written file — the two failures that would otherwise only be discovered
# during a restore. `tar --list` does the same for the trees.
echo "  verifying…"
pg_restore --list "$DEST/database.dump" > "$DEST/database.toc"
tar --list --gzip --file="$DEST/content.tar.gz" > "$DEST/content.toc"
tar --list --gzip --file="$DEST/uploads.tar.gz" > "$DEST/uploads.toc"

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # `uname -n` rather than `hostname`, which is not present in every
  # environment this runs in — a container built from a minimal base has
  # `uname` and may not have the hostname utility. An empty field here would
  # defeat the point of recording it.
  echo "hostname=$(uname -n 2>/dev/null || echo unknown)"
  echo "repo=$REPO_ROOT"
  echo "content_dir=$CONTENT_DIR"
  echo "upload_dir=$UPLOAD_DIR"
  # The URL without its password. A manifest is a file that gets copied around,
  # mailed, and dropped in a ticket; a credential in it outlives the incident.
  echo "database=$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+):[^@]*@#\1:***@#')"
  echo "postgres_version=$(pg_dump --version | head -1)"
  echo "content_files=$(wc -l < "$DEST/content.toc")"
  echo "upload_files=$(wc -l < "$DEST/uploads.toc")"
  echo "database_bytes=$(wc -c < "$DEST/database.dump")"
  echo "verified=yes"
} > "$DEST/MANIFEST"

echo "Done."
cat "$DEST/MANIFEST" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Prune
# ---------------------------------------------------------------------------

if [[ "$BACKUP_KEEP" -gt 0 ]]; then
  # `sort -r` on the timestamp names, so the newest survive. Only directories
  # matching the timestamp pattern are considered, so an unrelated directory
  # someone put here is never deleted.
  #
  # `mapfile` rather than a pipeline into the loop: a `while read` in a pipeline
  # runs in a subshell, and any variable set inside it is lost — which is the
  # classic way a prune script deletes nothing and reports success.
  mapfile -t OLD < <(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z' \
      | sort -r | tail -n "+$((BACKUP_KEEP + 1))"
  )

  if [[ ${#OLD[@]} -gt 0 ]]; then
    echo "Pruning ${#OLD[@]} backup(s) beyond the newest $BACKUP_KEEP:"
    for old in "${OLD[@]}"; do
      echo "  $(basename "$old")"
      rm -rf -- "$old"
    done
  fi
fi

echo
echo "Restore with: scripts/restore.sh $DEST"
