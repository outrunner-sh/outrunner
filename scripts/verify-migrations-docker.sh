#!/usr/bin/env bash
# Run scripts/verify-migrations.sh in a throwaway postgres:17 container, for a
# machine with Docker but no local Postgres. The repo's files are copied in,
# since Docker Desktop may not share the folder the repo is in. Exits non-zero
# if Postgres doesn't start or any migration or assertion fails, and always
# removes its container.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="mig-verify-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 30); do
  docker exec "$name" pg_isready -U postgres -q && break
  sleep 1
done
if ! docker exec "$name" pg_isready -U postgres -q; then
  docker logs "$name" >&2 || true
  echo "Postgres did not start within 30 seconds." >&2
  exit 1
fi

docker exec "$name" mkdir /work
docker cp "$repo_root/scripts" "$name:/work/"
docker cp "$repo_root/supabase" "$name:/work/"
docker exec -u postgres -e PG_BIN=/usr/lib/postgresql/17/bin "$name" bash /work/scripts/verify-migrations.sh
