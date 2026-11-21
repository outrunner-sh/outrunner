#!/usr/bin/env bash
# Apply supabase/migrations/*.sql to a throwaway local Postgres and assert the
# constraints and RLS policies behave as intended.
#
# This exists so schema changes are validated before they touch the real
# Supabase project. Requires local postgres (installed by the setup script).
set -euo pipefail

PG_BIN=${PG_BIN:-$(pg_config --bindir)}
PG_DATA=${PG_DATA:-}
PG_CONFIG=${PG_CONFIG:-}
PG_OS_USER=${PG_OS_USER:-postgres}
DB=${DB:-runtime_verify}
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

run_as_postgres() {
  if [ "$(id -un)" = "$PG_OS_USER" ]; then
    "$@"
  else
    sudo -u "$PG_OS_USER" "$@"
  fi
}

run_psql() { run_as_postgres "$PG_BIN/psql" -q "$@"; }

if ! run_as_postgres "$PG_BIN/pg_isready" -q; then
  echo "==> starting postgres"
  if [ -n "$PG_DATA" ]; then
    pg_opts=()
    if [ -n "$PG_CONFIG" ]; then
      pg_opts=(-o "-c config_file=$PG_CONFIG")
    fi
    run_as_postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" -l /tmp/runtime-pg.log "${pg_opts[@]}" start
  elif command -v pg_lsclusters >/dev/null 2>&1; then
    read -r version cluster _ < <(pg_lsclusters --no-header | head -n 1)
    if [ -z "${version:-}" ] || [ -z "${cluster:-}" ]; then
      echo "No PostgreSQL cluster found. Set PG_DATA (and optionally PG_CONFIG)." >&2
      exit 1
    fi
    sudo pg_ctlcluster "$version" "$cluster" start
  else
    echo "PostgreSQL is not running. Set PG_DATA (and optionally PG_CONFIG) to start it." >&2
    exit 1
  fi
  sleep 2
fi

echo "==> recreating $DB"
run_psql -c "drop database if exists $DB;" -c "create database $DB;"

# Minimal stand-ins for Supabase-managed auth and storage schemas. The storage
# bucket migration creates a policy on storage.objects, so this local verifier
# must model that catalog surface rather than failing before our migrations run.
echo "==> stubbing Supabase auth and storage schemas"
run_psql -d "$DB" -c "
  create schema if not exists auth;
  -- The columns migrations read: sign-up alerts (last_sign_in_at), own
  -- orgs' names (raw_user_meta_data).
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, last_sign_in_at timestamptz, raw_user_meta_data jsonb);
  create or replace function auth.uid() returns uuid language sql stable as \$\$
    select current_setting('request.jwt.claim.sub', true)::uuid
  \$\$;
  -- As Supabase has it: any role may call auth.uid().
  grant usage on schema auth to public;
  create schema if not exists storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);
  create or replace function storage.foldername(path text) returns text[] language sql immutable as \$\$
    select string_to_array(path, '/')
  \$\$;
  -- Supabase's API roles: migrations grant to and revoke from them.
  do \$\$ declare r text; begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin', r);
      end if;
    end loop;
  end \$\$;
  -- And their grants, as Supabase has them: every table, sequence and
  -- function public gets is granted in full to all three roles, so RLS and a
  -- migration's own revokes are what stand between them and the data. Without
  -- these the roles could do nothing, and an assertion or a migration guard
  -- that a client role can't write a table would hold whatever the
  -- migrations said.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;"

echo "==> applying migrations"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  run_psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done

echo "==> asserting constraints and RLS"
run_psql -d "$DB" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/scripts/schema-assertions.sql"

echo "==> OK"
