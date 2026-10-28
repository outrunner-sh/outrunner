-- Just enough of the schema the Missions migrations build on, for
-- test/missions-sql.test.ts: the roles, the workspaces table's columns they
-- read, and set_updated_at (20260731090000_init.sql).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid,
  status text not null default 'creating',
  branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
