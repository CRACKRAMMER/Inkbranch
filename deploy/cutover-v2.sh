#!/usr/bin/env bash
set -euo pipefail

cd /opt/inkbranch

mkdir -p /opt/inkbranch/content /opt/inkbranch/uploads /opt/inkbranch/backups
chmod 700 /opt/inkbranch/backups
chown -R 1001:1001 /opt/inkbranch/content /opt/inkbranch/uploads /opt/inkbranch/backups

if [ -f /opt/inkbranch/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/inkbranch/.env
  set +a
fi

if [ -f /opt/inkbranch/.initial-admin ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/inkbranch/.initial-admin
  set +a
fi

V1_PG_USER="${POSTGRES_USER:-myblog}"
V1_PG_DB="${POSTGRES_DB:-myblog}"
V2_PG_USER="${POSTGRES_USER:-inkbranch}"
V2_PG_DB="${POSTGRES_DB:-inkbranch}"

if docker ps --format '{{.Names}}' | grep -qx 'myblog-postgres-1'; then
  docker exec myblog-postgres-1 pg_dump -U "${V1_PG_USER}" -d "${V1_PG_DB}" --no-owner --no-acl > /opt/inkbranch/backups/pre-v2-pgdump.sql
  chmod 600 /opt/inkbranch/backups/pre-v2-pgdump.sql
  docker stop myblog-web-1 myblog-postgres-1 >/dev/null 2>&1 || true
  docker rm myblog-web-1 myblog-migrate-1 >/dev/null 2>&1 || true
fi

docker compose up -d postgres

for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U "${V2_PG_USER}" -d "${V2_PG_DB}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose exec -T postgres pg_isready -U "${V2_PG_USER}" -d "${V2_PG_DB}" >/dev/null

if [ -s /opt/inkbranch/backups/pre-v2-pgdump.sql ]; then
  if ! docker compose exec -T postgres psql -U "${V2_PG_USER}" -d "${V2_PG_DB}" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users'" | grep -q 1; then
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${V2_PG_USER}" -d "${V2_PG_DB}" < /opt/inkbranch/backups/pre-v2-pgdump.sql >/dev/null
  fi
fi

if docker compose pull web; then
  docker compose up -d --no-build web
else
  echo "WARN: GHCR pull failed; building locally"
  docker compose up -d --build web
fi

healthy=0
for _ in $(seq 1 30); do
  health_json="$(curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if printf '%s' "${health_json}" | grep -q '"status":"ok"'; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "${healthy}" -ne 1 ]; then
  echo "ERROR: Inkbranch v2 health check did not become ok in time" >&2
  docker compose ps >&2 || true
  docker compose logs web --tail=50 >&2 || true
  exit 1
fi

docker compose ps
docker images ghcr.io/crackrammer/inkbranch
docker stats --no-stream
stat -c "%a %s %n" /opt/inkbranch/backups/pre-v2-pgdump.sql 2>/dev/null || true
curl -fsS http://127.0.0.1:3000/api/health
echo
