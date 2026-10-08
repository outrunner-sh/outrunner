#!/usr/bin/env bash
# Apply the pending supabase/migrations to the hosted project. The Supabase CLI
# records each one in supabase_migrations.schema_migrations, so a migration runs
# once, and a migration already applied is never run again.
#
#   pnpm db:migrate              list what is pending, ask, then apply it
#   pnpm db:migrate --dry-run    only list what is pending
#   pnpm db:status               which migrations the database has recorded
#   pnpm db:repair --through V   record every migration up to version V as
#                                applied, without running it (see the README)
#
# Needs SUPABASE_DB_URL, from the environment or .env.local: Dashboard →
# Connect → Session pooler URI, with the database password filled in. It works
# over IPv4, unlike the direct host. The transaction pooler (port 6543) can't
# run migrations, so it is refused. The password is handed to the CLI in
# PGPASSWORD, never on its command line, where `ps` would show it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${SUPABASE_DB_URL:-}" ] && [ -f "$root/.env.local" ]; then
  SUPABASE_DB_URL="$(sed -n 's/^SUPABASE_DB_URL=//p' "$root/.env.local" | tail -n 1)"
fi
# An env file may quote the value.
SUPABASE_DB_URL="${SUPABASE_DB_URL%\"}" && SUPABASE_DB_URL="${SUPABASE_DB_URL#\"}"
SUPABASE_DB_URL="${SUPABASE_DB_URL%\'}" && SUPABASE_DB_URL="${SUPABASE_DB_URL#\'}"
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

# Split the password out of the URL (decoded, as PGPASSWORD wants it).
split="$(DB_URL="$SUPABASE_DB_URL" node -e '
  const url = new URL(process.env.DB_URL);
  const password = decodeURIComponent(url.password);
  url.password = "";
  process.stdout.write(url.toString() + "\n" + password);
')" || { echo "SUPABASE_DB_URL is not a valid URL." >&2; exit 1; }
db_url="${split%%$'\n'*}"
password="${split#*$'\n'}"
if [ -n "$password" ]; then
  export PGPASSWORD="$password"
fi

cd "$root"
case "${1:-}" in
  status)
    exec pnpm exec supabase migration list --db-url "$db_url"
    ;;
  repair)
    if [ "${2:-}" != "--through" ] || ! [[ "${3:-}" =~ ^[0-9]{14}$ ]]; then
      echo "Usage: pnpm db:repair --through <version>   (a 14-digit migration version)" >&2
      exit 1
    fi
    versions=()
    for file in supabase/migrations/*.sql; do
      version="$(basename "$file")"
      version="${version%%_*}"
      if [[ "$version" < "$3" || "$version" == "$3" ]]; then
        versions+=("$version")
      fi
    done
    if [ ${#versions[@]} -eq 0 ]; then
      echo "No migration is at or before $3." >&2
      exit 1
    fi
    echo "Recording as applied: ${versions[*]}"
    exec pnpm exec supabase migration repair --status applied "${versions[@]}" --db-url "$db_url"
    ;;
esac
exec pnpm exec supabase db push --db-url "$db_url" "$@"
