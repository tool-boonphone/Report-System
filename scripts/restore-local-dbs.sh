#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if docker ps >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo docker ps >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  echo "ERROR: Docker is not available."
  exit 1
fi

CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-report-system-postgres}"
BOONPHONE_DUMP_DIR="${BOONPHONE_DUMP_DIR:-$ROOT_DIR/dumps/boonphone-db.dir/2026-06-25T17:29Z/boonphone_db}"
BOONPHONE_DUMP_FILE="${BOONPHONE_DUMP_FILE:-$ROOT_DIR/dumps/boonphone_db_2026-06-25.dump}"
FASTFONE_DUMP_FILE="${FASTFONE_DUMP_FILE:-$ROOT_DIR/dumps/fastfone_db_2026-06-25.dump}"

if ! "${DOCKER[@]}" ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "ERROR: PostgreSQL container '$CONTAINER_NAME' is not running."
  echo "Start it with: docker compose up -d"
  exit 1
fi

if [[ -f "$BOONPHONE_DUMP_FILE" ]]; then
  BOONPHONE_SOURCE="$BOONPHONE_DUMP_FILE"
  BOONPHONE_FORMAT="custom"
elif [[ -d "$BOONPHONE_DUMP_DIR" ]]; then
  BOONPHONE_SOURCE="$BOONPHONE_DUMP_DIR"
  BOONPHONE_FORMAT="directory"
else
  echo "ERROR: Boonphone dump not found."
  echo "  expected file: $BOONPHONE_DUMP_FILE"
  echo "  or directory:  $BOONPHONE_DUMP_DIR"
  exit 1
fi

if [[ -f "$FASTFONE_DUMP_FILE" ]]; then
  FASTFONE_SOURCE="$FASTFONE_DUMP_FILE"
else
  FASTFONE_SOURCE=""
fi

echo "[restore] waiting for postgres in container..."
until "${DOCKER[@]}" exec "$CONTAINER_NAME" pg_isready -U report -d boonphone_db >/dev/null 2>&1; do
  sleep 2
done

restore_db() {
  local db_name="$1"
  local source_path="$2"

  echo "[restore] $db_name from $source_path"
  "${DOCKER[@]}" exec "$CONTAINER_NAME" psql -U report -d "$db_name" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

  if [[ -d "$source_path" ]]; then
    local container_dir="/tmp/restore-${db_name}"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" rm -rf "$container_dir"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" mkdir -p "$container_dir"
    "${DOCKER[@]}" cp "$source_path/." "${CONTAINER_NAME}:${container_dir}"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" pg_restore -U report -d "$db_name" --no-owner --no-acl "$container_dir"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" rm -rf "$container_dir"
  else
    local container_file="/tmp/${db_name}.dump"
    "${DOCKER[@]}" cp "$source_path" "${CONTAINER_NAME}:${container_file}"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" pg_restore -U report -d "$db_name" --no-owner --no-acl "$container_file"
    "${DOCKER[@]}" exec "$CONTAINER_NAME" rm -f "$container_file"
  fi
}

restore_db boonphone_db "$BOONPHONE_SOURCE"

if [[ -n "$FASTFONE_SOURCE" ]]; then
  restore_db fastfone_db "$FASTFONE_SOURCE"
else
  echo "[restore] fastfone_db: no dump — copying schema only from boonphone_db"
  "${DOCKER[@]}" exec "$CONTAINER_NAME" psql -U report -d fastfone_db -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
  "${DOCKER[@]}" exec "$CONTAINER_NAME" pg_dump -U report -d boonphone_db --schema-only \
    | "${DOCKER[@]}" exec -i "$CONTAINER_NAME" psql -U report -d fastfone_db -v ON_ERROR_STOP=1
fi

echo "[restore] done"
"${DOCKER[@]}" exec "$CONTAINER_NAME" psql -U report -d boonphone_db -c \
  "SELECT 'boonphone_db' AS db, COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = 'public';"
"${DOCKER[@]}" exec "$CONTAINER_NAME" psql -U report -d fastfone_db -c \
  "SELECT 'fastfone_db' AS db, COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = 'public';"
"${DOCKER[@]}" exec "$CONTAINER_NAME" psql -U report -d boonphone_db -tAc \
  "SELECT COUNT(*) FROM contracts;" | xargs -I{} echo "boonphone contracts: {}"
