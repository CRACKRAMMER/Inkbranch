#!/usr/bin/env bash
# Shared backup/restore configuration. Never source a secret-bearing dotenv file.
# Environment values win, then .env.local, then .env. Only simple single-line
# dotenv values are supported; variable expansion is deliberately absent.
read_dotenv_value() {
  local key="$1" file line value pattern selected found
  for file in "$REPO_ROOT/.env.local" "$REPO_ROOT/.env"; do
    [[ -f "$file" ]] || continue
    selected=""
    found=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      pattern="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$"
      [[ "$line" =~ $pattern ]] || continue
      found=1
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      pattern='^"(.*)"[[:space:]]*(#.*)?$'
      if [[ "$value" =~ $pattern ]]; then
        selected="${BASH_REMATCH[1]}"
      else
        pattern="^'(.*)'[[:space:]]*(#.*)?$"
        if [[ "$value" =~ $pattern ]]; then
          selected="${BASH_REMATCH[1]}"
        else
          value="${value%%#*}"
          value="${value%"${value##*[![:space:]]}"}"
          [[ "$value" != \"* && "$value" != \'* ]] || {
            echo "error: $key in $file must be a complete single-line dotenv value" >&2
            return 1
          }
          selected="$value"
        fi
      fi
    done < "$file"
    # Node's dotenv loader and Next's parser keep the last duplicate key.
    # Match that rule while retaining .env.local's precedence over .env.
    if [[ "$found" -eq 1 ]]; then
      printf '%s' "$selected"
      return
    fi
  done
}

load_backup_configuration() {
  local key value
  for key in DATABASE_URL CONTENT_DIR UPLOAD_DIR; do
    if [[ -z "${!key:-}" ]]; then
      value="$(read_dotenv_value "$key")" || return 1
      [[ -z "$value" ]] || export "$key=$value"
    fi
  done
  CONTENT_DIR="${CONTENT_DIR:-$REPO_ROOT/content}"
  if [[ -z "${UPLOAD_DIR:-}" ]]; then
    if [[ -d "$REPO_ROOT/uploads" ]]; then
      UPLOAD_DIR="$REPO_ROOT/uploads"
    else
      UPLOAD_DIR="$REPO_ROOT/public/uploads"
    fi
  fi
  CONTENT_DIR="$(safe_data_path "$CONTENT_DIR")" || return 1
  UPLOAD_DIR="$(safe_data_path "$UPLOAD_DIR")" || return 1
}

safe_data_path() {
  local logical physical
  logical="$(realpath -m -s -- "$1")"
  physical="$(realpath -m -- "$1")"
  [[ "$logical" == "$physical" ]] || {
    echo "error: symlinks are not supported in data directory paths: $1" >&2
    return 1
  }
  printf '%s' "$physical"
}

redact_dsn() {
  # Also hide query parameters: drivers can accept credentials in URL queries.
  printf '%s' "$1" | sed -E 's#(://[^/@]*):[^@]*@#\1:***@#; s#\?.*$#?***#'
}

free_name() {
  local base="$1" candidate="$1" suffix=1
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    suffix=$((suffix + 1))
    candidate="$base-$suffix"
  done
  printf '%s' "$candidate"
}
