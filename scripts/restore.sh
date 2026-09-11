#!/usr/bin/env bash
#
# Restore a backup produced by `scripts/backup.sh`.
#
# ## This destroys data, and says so first
#
# Restoring overwrites the database, the content tree and the uploads directory.
# The script prints exactly what it is about to replace and requires the word
# `restore` to be typed, unless `--yes` is passed. The confirmation is not
# ceremony: this is the one script here whose failure mode is losing work, and
# it is run by someone who is already having a bad day.
#
# ## What it will not do
#
# It will not drop the database. It restores into the existing one, and
# `pg_restore --clean --if-exists` drops the individual objects it is about to
# recreate. That keeps ownership, extensions and any other database on the same
# server untouched — dropping the database would take them with it.
#
# The content tree is *replaced*, not merged. A merge would leave files that
# exist now but were not in the backup, producing a site that is neither the
# backup nor what was there before — which is the hardest state to reason about.
# The current tree is moved aside rather than deleted, so a restore of the wrong
# backup is recoverable.
#
# Usage:
#   scripts/restore.sh backups/2026-09-11T10-30-00Z
#   scripts/restore.sh backups/2026-09-11T10-30-00Z --yes
#   scripts/restore.sh <dir> --database-only
#   scripts/restore.sh <dir> --files-only
#
# Environment:
#   DATABASE_URL   required; read from .env.local if it is not already set

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

SOURCE="${1:-}"
shift || true

ASSUME_YES=0
DATABASE_ONLY=0
FILES_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)         ASSUME_YES=1 ;;
    --database-only)  DATABASE_ONLY=1 ;;
    --files-only)     FILES_ONLY=1 ;;
    *) echo "error: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$SOURCE" ]]; then
  echo "usage: scripts/restore.sh <backup-directory> [--yes] [--database-only|--files-only]" >&2
  echo >&2
  echo "Available backups:" >&2
  find "${BACKUP_ROOT:-$REPO_ROOT/backups}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | sort -r | head -20 | sed 's/^/  /' >&2
  exit 2
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "error: $SOURCE is not a directory" >&2
  exit 1
fi

if [[ "$DATABASE_ONLY" -eq 1 && "$FILES_ONLY" -eq 1 ]]; then
  echo "error: --database-only and --files-only are mutually exclusive" >&2
  exit 2
fi

CONTENT_DIR="${CONTENT_DIR:-$REPO_ROOT/content}"
UPLOAD_DIR="${UPLOAD_DIR:-$REPO_ROOT/public/uploads}"

if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.local" | head -1 | cut -d= -f2-)"
  DATABASE_URL="${DATABASE_URL%\"}"
  DATABASE_URL="${DATABASE_URL#\"}"
  export DATABASE_URL
fi

# ---------------------------------------------------------------------------
# Verify before touching anything
# ---------------------------------------------------------------------------

# Every check that can fail happens before the first destructive command. A
# restore that destroys the current state and *then* discovers the archive is
# truncated has turned one problem into two.
echo "Checking $SOURCE"

if [[ -f "$SOURCE/MANIFEST" ]]; then
  grep -v '^database=' "$SOURCE/MANIFEST" | sed 's/^/  /'
else
  echo "  warning: no MANIFEST — this may not be a backup produced by backup.sh" >&2
fi

if [[ "$FILES_ONLY" -eq 0 ]]; then
  [[ -f "$SOURCE/database.dump" ]] || { echo "error: $SOURCE/database.dump is missing" >&2; exit 1; }
  pg_restore --list "$SOURCE/database.dump" >/dev/null \
    || { echo "error: database.dump is not a readable pg_dump archive" >&2; exit 1; }
fi

if [[ "$DATABASE_ONLY" -eq 0 ]]; then
  [[ -f "$SOURCE/content.tar.gz" ]] || { echo "error: $SOURCE/content.tar.gz is missing" >&2; exit 1; }
  tar --list --gzip --file="$SOURCE/content.tar.gz" >/dev/null \
    || { echo "error: content.tar.gz is not a readable archive" >&2; exit 1; }

  if [[ -f "$SOURCE/uploads.tar.gz" ]]; then
    tar --list --gzip --file="$SOURCE/uploads.tar.gz" >/dev/null \
      || { echo "error: uploads.tar.gz is not a readable archive" >&2; exit 1; }
  fi
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------

if [[ "$ASSUME_YES" -eq 0 ]]; then
  echo
  echo "This will REPLACE:"
  [[ "$FILES_ONLY" -eq 0 ]] && echo "  the database at   $(printf '%s' "${DATABASE_URL:-}" | sed -E 's#(://[^:]+):[^@]*@#\1:***@#')"
  [[ "$DATABASE_ONLY" -eq 0 ]] && echo "  the content tree  $CONTENT_DIR"
  [[ "$DATABASE_ONLY" -eq 0 ]] && echo "  the uploads       $UPLOAD_DIR"
  echo
  echo "with the contents of $SOURCE"
  echo
  echo "The current content and uploads directories are moved aside, not deleted."
  echo "Stop the application first — a running server holds sessions and may write"
  echo "to the database while it is being restored."
  echo
  read -r -p "Type 'restore' to continue: " reply
  if [[ "$reply" != "restore" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

if [[ "$DATABASE_ONLY" -eq 0 ]]; then
  # Moved aside with the same UTC timestamp format the backup uses, so it is
  # greppable and sorts with the real backups.
  ASIDE="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

  if [[ -d "$CONTENT_DIR" ]]; then
    echo "Moving $CONTENT_DIR aside to $CONTENT_DIR.before-$ASIDE"
    mv "$CONTENT_DIR" "$CONTENT_DIR.before-$ASIDE"
  fi

  echo "Extracting content…"
  mkdir -p "$(dirname "$CONTENT_DIR")"
  tar --extract --gzip --file="$SOURCE/content.tar.gz" \
      --directory="$(dirname "$CONTENT_DIR")"

  # An empty uploads directory produces a valid but entry-less archive, so
  # `-s` on the file is not enough — a gzip stream with nothing in it is still
  # a few dozen bytes. The table of contents is what says whether there is
  # anything to extract, and extracting nothing while announcing "Extracting
  # uploads" is how a reader concludes the media survived a restore it did not.
  if [[ -f "$SOURCE/uploads.tar.gz" ]] && [[ -n "$(tar --list --gzip --file="$SOURCE/uploads.tar.gz")" ]]; then
    if [[ -d "$UPLOAD_DIR" ]]; then
      echo "Moving $UPLOAD_DIR aside to $UPLOAD_DIR.before-$ASIDE"
      mv "$UPLOAD_DIR" "$UPLOAD_DIR.before-$ASIDE"
    fi
    echo "Extracting uploads…"
    mkdir -p "$(dirname "$UPLOAD_DIR")"
    tar --extract --gzip --file="$SOURCE/uploads.tar.gz" \
        --directory="$(dirname "$UPLOAD_DIR")"
  else
    echo "No uploads in this backup; leaving $UPLOAD_DIR untouched."
  fi

  echo "Restored files. The previous trees are at *.before-$ASIDE"
fi

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

if [[ "$FILES_ONLY" -eq 0 ]]; then
  echo "Restoring database…"

  # `--clean --if-exists` drops each object before recreating it, so a restore
  # over a populated database does not fail on the first primary key. `--single-transaction`
  # so a failure half way leaves the database as it was rather than half
  # restored — the tables are dropped and recreated inside one transaction that
  # either commits or rolls back.
  #
  # `--no-owner` because the role that restores is generally not the role that
  # dumped, and ownership is not something this application depends on.
  pg_restore \
    --dbname="$DATABASE_URL" \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    --single-transaction \
    --exit-on-error \
    "$SOURCE/database.dump"

  echo "Database restored."
fi

# ---------------------------------------------------------------------------
# After
# ---------------------------------------------------------------------------

cat <<'EOF'

Restored. Two things to do next:

  1. Reconcile the index against the files. The database and the content tree
     were restored separately, so a document added after the backup could exist
     in one and not the other:

       pnpm content:sync

  2. If the restore replaced the content tree while the application was
     running, restart it — the search index and the relations index are built
     in process and are now stale.

EOF
