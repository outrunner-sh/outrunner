#!/usr/bin/env bash
# Apply the pending supabase/migrations to the hosted project. The Supabase CLI
# records each one in supabase_migrations.schema_migrations, so a migration runs
# once, and a migration already applied is never run again.
#
#   pnpm db:migrate             list what is pending, ask, then apply it
#   pnpm db:migrate --dry-run   only list what is pending
#   pnpm db:status              which migrations the database has recorded
#
# Needs SUPABASE_DB_URL, from the environment or .env.local: Dashboard →
# Connect → Session pooler URI, with the database password filled in. It works
# over IPv4, unlike the direct host. The transaction pooler (port 6543) can't
# run migrations, so it is refused.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${SUPABASE_DB_URL:-}" ] && [ -f "$root/.env.local" ]; then
  SUPABASE_DB_URL="$(sed -n 's/^SUPABASE_DB_URL=//p' "$root/.env.local" | tail -n 1)"
fi
if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "Set SUPABASE_DB_URL in .env.local (Dashboard → Connect → Session pooler URI)." >&2
  exit 1
fi
case "$SUPABASE_DB_URL" in
  *:6543/*)
    echo "SUPABASE_DB_URL is the transaction pooler (:6543). Use the Session pooler URI (:5432)." >&2
    exit 1
    ;;
esac

cd "$root"
if [ "${1:-}" = "status" ]; then
  exec pnpm exec supabase migration list --db-url "$SUPABASE_DB_URL"
fi
exec pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" "$@"
