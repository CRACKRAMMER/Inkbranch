#!/usr/bin/env bash
#
# Restore a backup produced by `scripts/backup.sh`.
#
# ## This destroys data, and says so first
#
# Restoring overwrites the database and the content and uploads directories. The
# script prints exactly what it is about to replace and requires the word
# `restore` to be typed, unless `--yes` is passed. The confirmation is not
# ceremony: this is the one script here whose failure mode is losing work, and
# it is run by someone who is already having a bad day.
#
# ## What it will not do
#
# **It will not drop the database.** It restores into the existing one, and
# `pg_restore --clean --if-exists` drops the individual objects it is about to
# recreate. That keeps ownership, extensions and any other database on the same
# server untouched — dropping the database would take them with it.
#
# **It will not overwrite `.env`.** The archive carries the environment files
# because a restored site needs the session secret it was signed with, but the
# ones in the working tree may have been rotated deliberately since the backup
# was taken. They are extracted to `config.restored/` and the script says so; a
# secret that comes back from a backup is a secret you did not mean to restore.
#
# **It will not merge.** The content and uploads trees are *replaced*, not
# merged. A merge would leave files that exist now but were not in the backup,
# producing a site that is neither the backup nor what was there before — which
# is the hardest state to reason about. The current trees are moved aside rather
# than deleted, so a restore of the wrong backup is recoverable.
#
# ## Why it reads the archive before touching anything
#
# Every check that can fail happens before the first destructive command, and
# they are ordered so that the *reason* is right. The frame checksum is verified
# first — a truncated file has no manifest to read, and reporting one as "not a
# backup" sends the operator looking for the wrong problem. Then the manifest,
# because a file that is not a backup at all should be refused before the prompt
# asking to confirm. Then `pg_restore --list`, which proves the database half is
# a real dump: a restore that replaces the current state and *then* discovers the
# archive is damaged has turned one problem into two.
#
# Usage:
#   scripts/restore.sh backups/backup-2026-09-11.tar.zst
#   scripts/restore.sh backups/backup-2026-09-11.tar.zst --yes
#   scripts/restore.sh <archive> --database-only
#   scripts/restore.sh <archive> --files-only
#
# Environment:
#   DATABASE_URL   required; read from .env.local if it is not already set
#   CONTENT_DIR, UPLOAD_DIR   where the trees go back, if not the repo defaults

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

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"

if [[ -z "$SOURCE" ]]; then
  echo "usage: scripts/restore.sh <backup-file.tar.zst> [--yes] [--database-only|--files-only]" >&2
  echo >&2
  echo "Available backups:" >&2
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type f -name 'backup-*.tar.zst' 2>/dev/null \
    | sort -r | head -20 | sed 's/^/  /' >&2
  exit 2
fi

if [[ -d "$SOURCE" ]]; then
  echo "error: $SOURCE is a directory. Backups are single .tar.zst files." >&2
  echo "       Did you mean one of these?" >&2
  find "$SOURCE" -mindepth 1 -maxdepth 1 -name '*.tar.zst' 2>/dev/null | sort | sed 's/^/         /' >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "error: $SOURCE is not a file" >&2
  exit 1
fi

if [[ "$DATABASE_ONLY" -eq 1 && "$FILES_ONLY" -eq 1 ]]; then
  echo "error: --database-only and --files-only are mutually exclusive" >&2
  exit 2
fi

for tool in pg_restore zstd tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found" >&2; exit 1; }
done

CONTENT_DIR="${CONTENT_DIR:-$REPO_ROOT/content}"
UPLOAD_DIR="${UPLOAD_DIR:-$REPO_ROOT/uploads}"

# Where the archive's environment files are put. Deliberately not the paths the
# application reads — see the header.
CONFIG_DIR="$REPO_ROOT/config.restored"

# Which database is about to be replaced, and — when an inherited `DATABASE_URL`
# and the checkout's `.env.local` disagree — a sentence saying that the
# environment won. The rule (environment beats file) is the right one and is
# what `backup.sh` does too, but on *this* script the losing side is a database
# that is about to be overwritten, so the losing side is worth naming. A
# `DATABASE_URL` exported for a test, or left over in a shell from a deploy, is
# otherwise invisible: both targets look like a URL and only one of them is the
# one the operator had in mind.
DSN_SOURCE="the environment"
if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.local" | head -1 | cut -d= -f2-)"
  DATABASE_URL="${DATABASE_URL%\"}"
  DATABASE_URL="${DATABASE_URL#\"}"
  export DATABASE_URL
  DSN_SOURCE="$REPO_ROOT/.env.local"
fi

redact_dsn() { printf '%s' "$1" | sed -E 's#(://[^:]+):[^@]*@#\1:***@#'; }

# A name in the given directory that nothing occupies yet.
#
# The timestamp has second resolution, and `mv` onto an existing directory does
# not collide — it moves the tree *inside* it. A restore run twice in one second,
# or a retry after a failure, would bury the newer tree one level down in the
# older one's directory and leave both looking present. So the stamp is the name
# and a taken name gets the next free suffix, the same rule `backup.sh` uses for
# its archive: the second thing is never refused and never destroys the first.
free_name() {
  local base="$1" candidate="$1" n=1
  while [[ -e "$candidate" ]]; do
    n=$((n + 1))
    candidate="$base-$n"
  done
  printf '%s' "$candidate"
}

CONFLICTING_DSN=""
if [[ "$DSN_SOURCE" == "the environment" && -f "$REPO_ROOT/.env.local" ]]; then
  FILE_DSN="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.local" | head -1 | cut -d= -f2-)"
  FILE_DSN="${FILE_DSN%\"}"
  FILE_DSN="${FILE_DSN#\"}"
  if [[ -n "$FILE_DSN" && "$FILE_DSN" != "$DATABASE_URL" ]]; then
    CONFLICTING_DSN="$FILE_DSN"
  fi
fi

if [[ "$FILES_ONLY" -eq 0 && -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set and could not be read from .env.local" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Check the archive, then read the manifest out of it
# ---------------------------------------------------------------------------

echo "Reading $SOURCE"

# Integrity first. `zstd --test` checks the frame checksum zstd wrote when the
# archive was made, which is what catches a truncated or bit-rotted file — and
# it is the difference between telling the operator "this backup is damaged, use
# another one" and telling them "this is not a backup", which is a different
# search. The check is one pass over the file, and it runs before anything has
# been moved or dropped.
if ! ZSTD_ERROR="$(zstd --test "$SOURCE" 2>&1)"; then
  echo "error: $SOURCE is damaged — it does not match its own checksum:" >&2
  printf '%s\n' "$ZSTD_ERROR" | sed 's/^/       /' >&2
  echo "       Restore a different backup. A file that fails this check is" >&2
  echo "       truncated or corrupt, and half of it is worse than none of it." >&2
  exit 1
fi

# Then the manifest, alone, because everything else depends on knowing this is
# a backup. `tar --extract MANIFEST` fails when the member is not there, which
# is the cheapest possible answer to "is this the right kind of file".
if ! zstd --decompress --stdout --quiet "$SOURCE" | tar --extract --file=- -C "$TMP" MANIFEST 2>/dev/null; then
  echo "error: no MANIFEST inside $SOURCE — this is not a backup produced by scripts/backup.sh" >&2
  exit 1
fi

manifest_value() {
  sed -n "s/^$1=//p" "$TMP/MANIFEST" | head -1
}

# Where the trees came from. Used to find their member names in the archive,
# which are the source basenames — normally `content` and `uploads`, and
# whatever the operator's `CONTENT_DIR` was when it is not.
ARCHIVE_CONTENT="$(basename "$(manifest_value content_dir)")"
ARCHIVE_UPLOAD="$(basename "$(manifest_value upload_dir)")"
[[ -n "$ARCHIVE_CONTENT" ]] || ARCHIVE_CONTENT=content
[[ -n "$ARCHIVE_UPLOAD" ]] || ARCHIVE_UPLOAD=uploads

grep -v '^database=' "$TMP/MANIFEST" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Verify before touching anything
# ---------------------------------------------------------------------------

# What remains is reading the archive back as a tar and a dump. The table of
# contents is what every decision below is made from — which members this
# archive actually has, rather than which ones it is expected to have.
echo "Verifying…"
zstd --decompress --stdout --quiet "$SOURCE" | tar --list --file=- > "$TMP/toc"

# Echoes the line from the table of contents when the archive has this member,
# and nothing when it does not. Directories are listed by tar with a trailing
# slash, so `content` and `content/` are the same member and only one of them is
# in the listing. The `|| true` keeps the function's own exit status zero: it is
# called in conditions, and a helper whose failure depends on how it was called
# is a helper that fails differently under `set -e`.
member_line() {
  grep -m1 -x -- "$1" "$TMP/toc" || grep -m1 -x -- "$1/" "$TMP/toc" || true
}

if [[ "$DATABASE_ONLY" -eq 0 && -z "$(member_line "$ARCHIVE_CONTENT")" ]]; then
  echo "error: $SOURCE contains no $ARCHIVE_CONTENT/ member" >&2
  exit 1
fi

if [[ "$FILES_ONLY" -eq 0 ]]; then
  [[ -n "$(member_line database.dump)" ]] \
    || { echo "error: $SOURCE contains no database.dump" >&2; exit 1; }
  # Read back through the decompressor rather than trusted: this is the cheapest
  # proof that the largest member is a real dump and not a compressed error
  # message from the run that wrote it.
  zstd --decompress --stdout --quiet "$SOURCE" \
    | tar --extract --to-stdout --file=- database.dump \
    | pg_restore --list > /dev/null \
    || { echo "error: database.dump is not a readable pg_dump archive" >&2; exit 1; }
fi

HAS_UPLOADS=0
if [[ -n "$(member_line "$ARCHIVE_UPLOAD")" ]]; then
  HAS_UPLOADS=1
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------

# Printed whether or not the confirmation is skipped, because `--yes` is exactly
# the case where nobody is reading the prompt that would have shown it.
if [[ -n "$CONFLICTING_DSN" ]]; then
  echo
  echo "NOTE: DATABASE_URL is set in the environment and differs from the one in"
  echo "      $REPO_ROOT/.env.local. The environment wins, so this run targets:"
  echo "        $(redact_dsn "$DATABASE_URL")"
  echo "      and not the one .env.local names:"
  echo "        $(redact_dsn "$CONFLICTING_DSN")"
  echo "      Unset DATABASE_URL to use the file."
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  echo
  echo "This will REPLACE:"
  if [[ "$FILES_ONLY" -eq 0 ]]; then
    echo "  the database at   $(redact_dsn "${DATABASE_URL:-}")"
    echo "                    (from $DSN_SOURCE)"
  fi
  if [[ "$DATABASE_ONLY" -eq 0 ]]; then
    echo "  the content tree  $CONTENT_DIR"
    if [[ "$HAS_UPLOADS" -eq 1 ]]; then
      echo "  the uploads       $UPLOAD_DIR"
    fi
  fi
  echo
  echo "with the contents of $SOURCE"
  echo
  if [[ "$DATABASE_ONLY" -eq 0 ]]; then
    echo "The current trees are moved aside, not deleted, so this is recoverable."
    echo ".env files in the archive land in config.restored/ and never over yours."
  fi
  if [[ "$FILES_ONLY" -eq 0 ]]; then
    echo "Stop the application first — a running server holds sessions and may"
    echo "write to the database while it is being restored."
  fi
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
  # A tree is *replaced*, never merged — and each member carries the name it was
  # taken under, which is extracted into the configured tree's parent. When the
  # two names are the same that is the tree itself and it is about to move aside;
  # when they differ, an unrelated directory of the archive's name could be
  # sitting in that parent, and tar would write over its contents. Checked here,
  # before anything has moved, so a refusal leaves the tree exactly where it was.
  for pair in "$ARCHIVE_CONTENT:$CONTENT_DIR" "$ARCHIVE_UPLOAD:$UPLOAD_DIR"; do
    member="${pair%%:*}"
    tree="${pair#*:}"
    target="$(dirname "$tree")/$member"
    if [[ -e "$target" && "$target" != "$tree" ]]; then
      echo "error: $target already exists and is not $tree" >&2
      echo "       Refusing to extract over it. Move it out of the way and re-run." >&2
      exit 1
    fi
  done

  # Moved aside with the same timestamp format the log lines use, so it is
  # greppable and sorts alongside the backups.
  ASIDE="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

  if [[ -d "$CONTENT_DIR" ]]; then
    CONTENT_ASIDE="$(free_name "$CONTENT_DIR.before-$ASIDE")"
    echo "Moving $CONTENT_DIR aside to $CONTENT_ASIDE"
    mv -- "$CONTENT_DIR" "$CONTENT_ASIDE"
  fi

  if [[ "$HAS_UPLOADS" -eq 1 && -d "$UPLOAD_DIR" ]]; then
    UPLOAD_ASIDE="$(free_name "$UPLOAD_DIR.before-$ASIDE")"
    echo "Moving $UPLOAD_DIR aside to $UPLOAD_ASIDE"
    mv -- "$UPLOAD_DIR" "$UPLOAD_ASIDE"
  fi

  echo "Extracting…"
  # One decompression for both trees: `-C` is positional in GNU tar, so each
  # member is written under the parent that follows it. Streaming the whole
  # archive twice would double the read for no gain.
  mkdir -p "$(dirname "$CONTENT_DIR")"
  if [[ "$HAS_UPLOADS" -eq 1 ]]; then
    mkdir -p "$(dirname "$UPLOAD_DIR")"
    zstd --decompress --stdout --quiet "$SOURCE" \
      | tar --extract --file=- -C "$(dirname "$CONTENT_DIR")" "$ARCHIVE_CONTENT" \
                                -C "$(dirname "$UPLOAD_DIR")" "$ARCHIVE_UPLOAD"
  else
    echo "  (no uploads member in this backup — leaving $UPLOAD_DIR untouched)"
    zstd --decompress --stdout --quiet "$SOURCE" \
      | tar --extract --file=- -C "$(dirname "$CONTENT_DIR")" "$ARCHIVE_CONTENT"
  fi

  # The archive names each tree after the directory it was taken from, which is
  # the default far more often than not — but a deployment that set `CONTENT_DIR`
  # gets the tree back under the name *this* run expects. Renaming is a move
  # within the same parent, so it cannot cross a filesystem.
  if [[ "$ARCHIVE_CONTENT" != "$(basename "$CONTENT_DIR")" ]]; then
    mv -- "$(dirname "$CONTENT_DIR")/$ARCHIVE_CONTENT" "$CONTENT_DIR"
  fi
  if [[ "$HAS_UPLOADS" -eq 1 && "$ARCHIVE_UPLOAD" != "$(basename "$UPLOAD_DIR")" ]]; then
    mv -- "$(dirname "$UPLOAD_DIR")/$ARCHIVE_UPLOAD" "$UPLOAD_DIR"
  fi

  # The environment files go to a side directory, and a previous restore's copy
  # is moved aside rather than deleted or overwritten. It is the one directory
  # here that could hold something an operator edited by hand — the file in it
  # came out of a backup, and a backup is a snapshot, not the current truth.
  if [[ -n "$(member_line config)" ]]; then
    echo "Extracting environment files to $(basename "$CONFIG_DIR")/ — your .env files are not touched"
    mkdir -p "$TMP/config"
    zstd --decompress --stdout --quiet "$SOURCE" \
      | tar --extract --file=- -C "$TMP" config
    if [[ -e "$CONFIG_DIR" ]]; then
      mv -- "$CONFIG_DIR" "$(free_name "$CONFIG_DIR.before-$ASIDE")"
    fi
    mv -- "$TMP/config" "$CONFIG_DIR"
    find "$CONFIG_DIR" -type f | sed "s#^$CONFIG_DIR/#  #"
  fi

  echo "Restored files. The previous trees are at *.before-$ASIDE"
fi

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

if [[ "$FILES_ONLY" -eq 0 ]]; then
  echo "Restoring database…"

  # `--clean --if-exists` drops each object before recreating it, so a restore
  # over a populated database does not fail on the first primary key.
  # `--single-transaction` so a failure half way leaves the database as it was
  # rather than half restored — the tables are dropped and recreated inside one
  # transaction that either commits or rolls back.
  #
  # `--no-owner` because the role that restores is generally not the role that
  # dumped, and ownership is not something this application depends on.
  #
  # Read straight from the archive rather than from a file on disk: the dump is
  # the largest member by far, and writing it out to read it back would need as
  # much free space as the database itself. `pg_restore` reads the archive on
  # standard input when no filename is given — the pipe *is* the argument.
  zstd --decompress --stdout --quiet "$SOURCE" \
    | tar --extract --to-stdout --file=- database.dump \
    | pg_restore \
        --dbname="$DATABASE_URL" \
        --clean \
        --if-exists \
        --no-owner \
        --no-privileges \
        --single-transaction \
        --exit-on-error

  echo "Database restored."
fi

# ---------------------------------------------------------------------------
# After
# ---------------------------------------------------------------------------

cat <<'EOF'

Restored. Three things to do next:

  1. Reconcile the index against the files. The database and the content tree
     were restored separately, so a document added after the backup could exist
     in one and not the other:

       pnpm content:sync

  2. Restart the application if it was running. The search index and the
     relations index are built in process and are now stale.

  3. Check config.restored/ against your .env files. A session secret that came
     back from a backup signs sessions with a key you may have rotated on
     purpose, and the archive's copy is the one from the day it was taken.

EOF
