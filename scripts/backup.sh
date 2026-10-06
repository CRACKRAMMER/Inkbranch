#!/usr/bin/env bash
#
# Back up everything this site cannot regenerate.
#
# ## What is in a backup, and what is not
#
# Four things are irreplaceable: the database (index, sessions, tags,
# revisions, audit log, analytics), `content/` (the Markdown, which is the
# source of truth), the uploads directory (the media, which the Markdown points
# at), and the environment files (without which a restored site cannot sign
# anybody in).
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
# ## The archive, and why it is one file
#
#   backup-2026-09-11.tar.zst
#     database.dump        pg_dump, custom format (restorable in parts)
#     content/             the Markdown tree
#     uploads/             the media tree
#     config/              the environment files, verbatim
#     MANIFEST             what this is, from where, and whether it verified
#
# One file rather than a directory of them, because a backup that is a directory
# is a backup that gets half copied. `scp`, `rsync`, a USB stick and an object
# store all have a way to leave a directory incomplete; none of them has a way to
# leave a single file incomplete without saying so.
#
# The compression is zstd, applied once, over a plain tar. The trees inside are
# *not* compressed individually: gzipping a gzip stream gains nothing and costs
# a second pass over every byte.
#
# Nothing is written to the destination until the archive is complete. A backup
# that fails halfway leaves the previous one untouched, and the collision rule
# below means it never lands on top of an earlier backup either.
#
# ## The contents are secret-bearing
#
# `config/` is the environment files verbatim, so the archive holds
# `SESSION_SECRET` and the database password — and `database.dump` already held
# every password hash, every live session token, and the audit log. Treat the
# whole file the way you would treat the `.env` itself: it is not something to
# mail, and the manifest records only the redacted database URL.
#
# Usage:
#   scripts/backup.sh                 # writes to ./backups
#   scripts/backup.sh /mnt/backups    # writes elsewhere
#
# Environment:
#   DATABASE_URL   required; read from .env.local if it is not already set
#   BACKUP_KEEP    how many backups to retain (default 14, 0 disables pruning)
#   BACKUP_LABEL   appended to the filename, e.g. `pre-upgrade`

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BACKUP_ROOT="${1:-$REPO_ROOT/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_LABEL="${BACKUP_LABEL:-}"

source "$REPO_ROOT/scripts/lib/backup-common.sh"
load_backup_configuration

[[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] || { echo "error: BACKUP_KEEP must be a non-negative integer" >&2; exit 2; }
[[ "$BACKUP_LABEL" =~ ^[A-Za-z0-9_-]*$ ]] || { echo "error: BACKUP_LABEL may contain only letters, digits, underscores and hyphens" >&2; exit 2; }

CONFIG_FILES=()
for candidate in .env .env.local; do
  [[ -f "$REPO_ROOT/$candidate" ]] && CONFIG_FILES+=("$candidate")
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set and could not be read from .env.local or .env" >&2
  exit 1
fi

for tool in pg_dump pg_restore zstd tar realpath flock; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found. Install postgresql-client and zstd, or run this" >&2
    echo "       inside the compose network with:" >&2
    echo "       docker compose exec postgres pg_dump ..." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Destination
# ---------------------------------------------------------------------------

# `%Y-%m-%d` in UTC. The spec names the file by its date, and a date is what
# makes "the backup from just before the incident" findable by eye.
STAMP="$(date -u +%Y-%m-%d)"

# **A same-day backup is never overwritten.** Two runs on one day is the normal
# case — a nightly job and a manual one taken before an upgrade — and the manual
# one is the one you actually need afterwards. Refusing the second would make
# the operator choose between the two; overwriting it would destroy the first.
# So the name is the date, and a name already taken gets the next free suffix.
mkdir -p "$BACKUP_ROOT"
# Reserve the destination namespace while choosing a name and pruning. Two
# concurrent backups must never publish or remove each other's archive.
exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || { echo 'error: another backup is running in this destination' >&2; exit 1; }
SUFFIX=""
index=1
while :; do
  NAME="backup-$STAMP${BACKUP_LABEL:+-$BACKUP_LABEL}${SUFFIX}.tar.zst"
  [[ ! -e "$BACKUP_ROOT/$NAME" ]] && break
  index=$((index + 1))
  SUFFIX="-$index"
done

ARCHIVE="$BACKUP_ROOT/$NAME"

# The staging directory is where the pieces are assembled before anything is
# compressed. It is a sibling of the archive so the final `mv` is a rename
# within one filesystem — atomic, and it cannot leave a half-written archive
# under the name a restore script will later be pointed at.
STAGING="$(mktemp -d "$BACKUP_ROOT/.staging-XXXXXX")"
cleanup() {
  rm -rf -- "$STAGING"
  rm -f -- "$ARCHIVE.partial"
}
trap cleanup EXIT

echo "Backing up to $ARCHIVE"

# ---------------------------------------------------------------------------
# The database
# ---------------------------------------------------------------------------

echo "  database…"
pg_dump \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$STAGING/database.dump" \
  "$DATABASE_URL"

# Fail rather than silently archiving a partial dump. `pg_dump` exits non-zero
# on most failures, but a dump that exits zero having written nothing useful is
# the failure this catches.
if [[ ! -s "$STAGING/database.dump" ]]; then
  echo "error: pg_dump produced an empty file" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The config
# ---------------------------------------------------------------------------

# Members that live in the staging directory, named explicitly so an absent
# `config/` is a smaller archive rather than a tar that refuses to start.
STAGED_MEMBERS=(database.dump MANIFEST)

if [[ ${#CONFIG_FILES[@]} -gt 0 ]]; then
  echo "  config…"
  mkdir -p "$STAGING/config"
  # Permissions are preserved by the tar below, so a restored `.env` is not
  # suddenly world-readable.
  for file in "${CONFIG_FILES[@]}"; do
    cp -p "$REPO_ROOT/$file" "$STAGING/config/$file"
  done
  STAGED_MEMBERS+=(config)
else
  echo "  config… (no .env or .env.local found — nothing to archive)"
fi

# ---------------------------------------------------------------------------
# The trees
# ---------------------------------------------------------------------------

# Copy into stable archive member names; custom source basenames may collide.
# Stop application/worker writes and external edits for a coherent snapshot.
# Refuse missing trees and symlinks instead of creating an incomplete backup.
for tree in "$CONTENT_DIR" "$UPLOAD_DIR"; do
  [[ -d "$tree" && ! -L "$tree" ]] || { echo "error: missing or symlinked data directory: $tree" >&2; exit 1; }
  if [[ -n "$(find "$tree" -type l -print -quit)" ]]; then
    echo "error: symlinks are not supported in backup data: $tree" >&2
    exit 1
  fi
done
cp -a -- "$CONTENT_DIR" "$STAGING/content"
cp -a -- "$UPLOAD_DIR" "$STAGING/uploads"
rm -rf -- "$STAGING/content/.locks" "$STAGING/content/.tmp"
CONTENT_FILES="$(find "$STAGING/content" -type f | wc -l)"
UPLOAD_FILES="$(find "$STAGING/uploads" -type f | wc -l)"
STAGED_MEMBERS+=(content uploads)

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

{
  echo "archive_version=2"
  echo "content_member=content"
  echo "upload_member=uploads"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # `uname -n` rather than `hostname`, which is not present in every
  # environment this runs in — a container built from a minimal base has
  # `uname` and may not have the hostname utility. An empty field here would
  # defeat the point of recording it.
  echo "hostname=$(uname -n 2>/dev/null || echo unknown)"
  echo "repo=$REPO_ROOT"
  echo "content_dir=$CONTENT_DIR"
  echo "upload_dir=$UPLOAD_DIR"
  echo "config_files=${CONFIG_FILES[*]:-none}"
  # The URL without its password. A manifest is a file that gets copied around,
  # mailed, and dropped in a ticket; a credential in it outlives the incident.
  echo "database=$(redact_dsn "$DATABASE_URL")"
  echo "postgres_version=$(pg_dump --version | head -1)"
  echo "content_files=$CONTENT_FILES"
  echo "upload_files=$UPLOAD_FILES"
} > "$STAGING/MANIFEST"

# ---------------------------------------------------------------------------
# Archive and verify
# ---------------------------------------------------------------------------

echo "  archiving…"
# `-T0` uses every core; `-9` is well past the point where more level buys
# anything for Markdown and JSON, and still fast enough that a nightly job is
# not a nightly wait.
tar --create \
    --format=pax \
    --hard-dereference \
    --use-compress-program="zstd -9 -T0" \
    --file="$ARCHIVE.partial" \
    -C "$STAGING" "${STAGED_MEMBERS[@]}"

# A backup nobody has read back is a hope, not a backup. `zstd -t` verifies the
# checksum zstd writes into the frame — which catches truncation and a
# half-written file, the two failures that would otherwise only be discovered
# during a restore. `pg_restore --list` then parses the dump's table of contents
# from inside the verified archive, which is the cheapest proof that the
# database half is real rather than a compressed error message.
echo "  verifying…"
zstd --test --quiet "$ARCHIVE.partial"
zstd --decompress --stdout --quiet "$ARCHIVE.partial" | tar --list --file=- > "$STAGING/.toc"
zstd --decompress --stdout --quiet "$ARCHIVE.partial" \
  | tar --extract --to-stdout --file=- database.dump \
  | pg_restore --list > "$STAGING/.pg-restore-toc"

if ! grep -q '^database.dump$' "$STAGING/.toc"; then
  echo "error: the archive does not contain database.dump" >&2
  exit 1
fi

# Only now does the archive get its real name. Everything above this line can
# fail without touching a file a restore might be pointed at.
mv -- "$ARCHIVE.partial" "$ARCHIVE"
rm -f -- "$STAGING/.toc" "$STAGING/.pg-restore-toc"

MANIFEST="$(cat "$STAGING/MANIFEST")"
ARCHIVE_BYTES="$(wc -c < "$ARCHIVE")"

echo
echo "Done."
printf '%s\n' "$MANIFEST" | sed 's/^/  /' | head -4
echo "  archive=$(basename "$ARCHIVE")"
echo "  archive_bytes=$ARCHIVE_BYTES"
echo "  verified=yes"

# ---------------------------------------------------------------------------
# Prune
# ---------------------------------------------------------------------------

if [[ "$BACKUP_KEEP" -gt 0 ]]; then
  # Only files this script would have written are considered, so an unrelated
  # file someone dropped here is never deleted.
  #
  # `mapfile` rather than a pipeline into the loop: a `while read` in a pipeline
  # runs in a subshell, and any variable set inside it is lost — which is the
  # classic way a prune script deletes nothing and reports success.
  mapfile -t OLD < <(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type f \
      -regextype posix-extended -regex '.*/backup-[0-9]{4}-[0-9]{2}-[0-9]{2}.*\.tar\.zst' \
      -printf '%T@ %p\n' | sort -nr | tail -n "+$((BACKUP_KEEP + 1))" | cut -d' ' -f2-
  )

  if [[ ${#OLD[@]} -gt 0 ]]; then
    echo
    echo "Pruning ${#OLD[@]} backup(s) beyond the newest $BACKUP_KEEP:"
    for old in "${OLD[@]}"; do
      echo "  $(basename "$old")"
      rm -f -- "$old"
    done
  fi
fi

echo
echo "Restore with: scripts/restore.sh $ARCHIVE"
