#!/usr/bin/env bash
# Restore only validated backups. Files are staged before swapping, and a
# failed single-transaction database restore rolls the file swaps back.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/backup-common.sh"

SOURCE="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi
ASSUME_YES=0
DATABASE_ONLY=0
FILES_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --database-only) DATABASE_ONLY=1 ;;
    --files-only) FILES_ONLY=1 ;;
    *) echo "error: unknown option $arg" >&2; exit 2 ;;
  esac
done
[[ -n "$SOURCE" ]] || { echo 'usage: scripts/restore.sh <backup.tar.zst> [--yes] [--database-only|--files-only]' >&2; exit 2; }
[[ -f "$SOURCE" ]] || { echo "error: backup is not a file: $SOURCE" >&2; exit 1; }
[[ "$DATABASE_ONLY" -eq 0 || "$FILES_ONLY" -eq 0 ]] || { echo 'error: --database-only and --files-only are mutually exclusive' >&2; exit 2; }
for tool in zstd tar realpath flock chown; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
if [[ "$FILES_ONLY" -eq 0 ]]; then
  command -v pg_restore >/dev/null || { echo 'error: pg_restore not found' >&2; exit 1; }
fi

EXPORTED_DSN="${DATABASE_URL:-}"
FILE_DSN="$(read_dotenv_value DATABASE_URL)"
load_backup_configuration
if [[ "$FILES_ONLY" -eq 0 && -z "${DATABASE_URL:-}" ]]; then
  echo 'error: DATABASE_URL is not set and could not be read from .env.local or .env' >&2
  exit 1
fi
CONFIG_DIR="$REPO_ROOT/config.restored"
exec 9>"$REPO_ROOT/.restore.lock"
flock -n 9 || { echo 'error: another restore is running in this checkout' >&2; exit 1; }
TMP="$(mktemp -d)"
COMMITTED=0
SWAPPED=()
ASIDES=()
STAGES=()
cleanup() {
  local status=$? index target aside
  set +e
  if [[ "$COMMITTED" -eq 0 ]]; then
    # Roll back every completed swap, in reverse order. A database restore
    # error is atomic in Postgres and therefore leaves both resources unchanged.
    for ((index=${#SWAPPED[@]}-1; index>=0; index--)); do
      target="${SWAPPED[$index]}"
      aside="${ASIDES[$index]}"
      if [[ -e "$target" ]] && ! rm -rf -- "$target"; then
        echo "error: rollback could not remove $target; recover its previous tree from $aside" >&2
        status=1
        continue
      fi
      if [[ -n "$aside" ]]; then
        if ! mv -- "$aside" "$target"; then
          echo "error: rollback failed; recover $target from $aside" >&2
          status=1
        fi
      fi
    done
  fi
  for target in "${STAGES[@]}"; do rm -rf -- "$target"; done
  rm -rf -- "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Verify the complete compressed stream and its tar member types before any
# extraction. Links and special devices have no place in a Markdown backup.
echo "Reading $SOURCE"
zstd --test --quiet "$SOURCE" || { echo 'error: backup checksum failed; nothing has been replaced' >&2; exit 1; }
zstd --decompress --stdout --quiet "$SOURCE" | tar --list --file=- --quoting-style=escape > "$TMP/toc"
zstd --decompress --stdout --quiet "$SOURCE" | tar --list --verbose --file=- > "$TMP/types"
if [[ -n "$(sed -n '/^[^-d]/p' "$TMP/types")" ]]; then
  echo 'error: backup contains a link or special file; nothing has been replaced' >&2
  exit 1
fi
# Reject duplicate members, traversal and escaped control characters. GNU tar
# escapes names in the listing, making newlines and backslashes detectable.
if [[ -n "$(sort "$TMP/toc" | uniq -d)" ]]; then
  echo 'error: backup contains duplicate members' >&2
  exit 1
fi
while IFS= read -r member; do
  case "$member" in
    /*|*\\*|../*|*/../*|*/..|./*|*/./*|*/.) echo "error: unsafe archive member: $member" >&2; exit 1 ;;
  esac
done < "$TMP/toc"

# Only the manifest is read before selecting the permitted top-level members.
grep -qx 'MANIFEST' "$TMP/toc" || { echo 'error: backup has no MANIFEST' >&2; exit 1; }
zstd --decompress --stdout --quiet "$SOURCE" | tar --extract --file=- -C "$TMP" MANIFEST
manifest_value() { sed -n "s/^$1=//p" "$TMP/MANIFEST" | head -1; }
ARCHIVE_CONTENT="$(manifest_value content_member)"
ARCHIVE_UPLOAD="$(manifest_value upload_member)"
[[ -n "$ARCHIVE_CONTENT" ]] || ARCHIVE_CONTENT="$(basename "$(manifest_value content_dir)")"
[[ -n "$ARCHIVE_UPLOAD" ]] || ARCHIVE_UPLOAD="$(basename "$(manifest_value upload_dir)")"
for member in "$ARCHIVE_CONTENT" "$ARCHIVE_UPLOAD"; do
  [[ -n "$member" && "$member" != . && "$member" != .. && "$member" != */* && "$member" != *\\* ]] || { echo 'error: invalid archive tree name' >&2; exit 1; }
  [[ "$member" != MANIFEST && "$member" != config && "$member" != database.dump ]] || { echo 'error: reserved archive tree name' >&2; exit 1; }
done
[[ "$ARCHIVE_CONTENT" != "$ARCHIVE_UPLOAD" ]] || { echo 'error: archive data trees have conflicting names' >&2; exit 1; }
HAS_UPLOADS=0
HAS_CONFIG=0
while IFS= read -r member; do
  case "$member" in
    MANIFEST|database.dump|"$ARCHIVE_CONTENT"/|"$ARCHIVE_CONTENT"/*) ;;
    "$ARCHIVE_UPLOAD"/|"$ARCHIVE_UPLOAD"/*) HAS_UPLOADS=1 ;;
    config/|config/.env|config/.env.local) HAS_CONFIG=1 ;;
    *) echo "error: unexpected archive member: $member" >&2; exit 1 ;;
  esac
done < "$TMP/toc"
if [[ "$DATABASE_ONLY" -eq 0 ]]; then
  grep -Fqx "$ARCHIVE_CONTENT/" "$TMP/toc" || { echo 'error: backup has no content tree' >&2; exit 1; }
fi
if [[ "$FILES_ONLY" -eq 0 ]]; then
  grep -qx 'database.dump' "$TMP/toc" || { echo 'error: backup has no database.dump' >&2; exit 1; }
  zstd --decompress --stdout --quiet "$SOURCE" | tar --extract --to-stdout --file=- database.dump | pg_restore --list >/dev/null
fi

if [[ -n "$EXPORTED_DSN" && -n "$FILE_DSN" && "$EXPORTED_DSN" != "$FILE_DSN" ]]; then
  echo "NOTE: exported DATABASE_URL overrides dotenv: $(redact_dsn "$DATABASE_URL")"
fi
echo 'This restore will replace:'
if [[ "$FILES_ONLY" -eq 0 ]]; then echo "  database: $(redact_dsn "$DATABASE_URL")"; fi
if [[ "$DATABASE_ONLY" -eq 0 ]]; then
  echo "  content: $CONTENT_DIR"
  if [[ "$HAS_UPLOADS" -eq 1 ]]; then echo "  uploads: $UPLOAD_DIR"; fi
  echo "  recovered config: $CONFIG_DIR (live .env files are untouched)"
fi
if [[ "$ASSUME_YES" -eq 0 ]]; then
  echo 'Stop the application, worker and external edits before continuing.'
  read -r -p "Type 'restore' to continue: " reply
  [[ "$reply" == restore ]] || { echo 'Aborted.'; exit 1; }
fi

if [[ "$DATABASE_ONLY" -eq 0 ]]; then
  # Refuse replacing a root, the checkout itself, or overlapping directories.
  # Resolve paths for containment and separately reject a symlinked path, since
  # realpath alone would silently follow it to a different directory.
  for tree in "$CONTENT_DIR" "$UPLOAD_DIR"; do
    [[ "$tree" != / && "$tree" != "$REPO_ROOT" && "$REPO_ROOT" != "$tree"/* ]] || { echo "error: unsafe restore target: $tree" >&2; exit 1; }
  done
  [[ "$CONTENT_DIR" != "$UPLOAD_DIR" && "$CONTENT_DIR" != "$UPLOAD_DIR"/* && "$UPLOAD_DIR" != "$CONTENT_DIR"/* ]] || { echo 'error: overlapping content/upload targets' >&2; exit 1; }
  for tree in "$CONTENT_DIR" "$UPLOAD_DIR"; do
    [[ "$tree" != "$CONFIG_DIR" && "$tree" != "$CONFIG_DIR"/* && "$CONFIG_DIR" != "$tree"/* ]] || { echo 'error: data target overlaps recovered configuration' >&2; exit 1; }
  done
  # Fully extract to private staging first, so tar or space failures cannot
  # remove the currently installed trees.
  zstd --decompress --stdout --quiet "$SOURCE" | tar --extract --file=- --no-same-owner -C "$TMP"
  stage_tree() {
    local member="$1" target="$2" stage
    mkdir -p -- "$(dirname "$target")"
    stage="$(mktemp -d "$(dirname "$target")/.inkbranch-restore-XXXXXX")"
    STAGES+=("$stage")
    cp -a -- "$TMP/$member/." "$stage/"
    # cp into an existing mktemp directory does not carry the tree's mode.
    chmod --reference="$TMP/$member" "$stage"
    # Bind-mounted data must remain writable by its application uid. Preserve
    # the current target owner rather than installing a tree owned by whichever
    # host user happened to invoke restore. Permission failures happen before
    # any swap, so an unprivileged restore cannot quietly break CMS writes.
    if [[ -e "$target" ]]; then
      chown -R --reference="$target" -- "$stage"
    fi
  }
  stage_tree "$ARCHIVE_CONTENT" "$CONTENT_DIR"
  if [[ "$HAS_UPLOADS" -eq 1 ]]; then stage_tree "$ARCHIVE_UPLOAD" "$UPLOAD_DIR"; fi
  if [[ "$HAS_CONFIG" -eq 1 ]]; then stage_tree config "$CONFIG_DIR"; fi
  ASIDE_STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  stage_index=0
  swap_tree() {
    local target="$1" stage="${STAGES[$stage_index]}" aside=""
    stage_index=$((stage_index + 1))
    if [[ -e "$target" || -L "$target" ]]; then
      aside="$(free_name "$target.before-$ASIDE_STAMP")"
      mv -- "$target" "$aside"
    fi
    SWAPPED+=("$target")
    ASIDES+=("$aside")
    mv -- "$stage" "$target"
  }
  swap_tree "$CONTENT_DIR"
  if [[ "$HAS_UPLOADS" -eq 1 ]]; then swap_tree "$UPLOAD_DIR"; fi
  if [[ "$HAS_CONFIG" -eq 1 ]]; then swap_tree "$CONFIG_DIR"; fi
fi

if [[ "$FILES_ONLY" -eq 0 ]]; then
  echo 'Restoring database…'
  zstd --decompress --stdout --quiet "$SOURCE" | tar --extract --to-stdout --file=- database.dump |
    pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error
fi
COMMITTED=1
echo 'Restored. Previous trees are retained as *.before-<timestamp>.'
echo 'Run pnpm content:sync, restart the application, and review config.restored/.'
