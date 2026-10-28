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

-- An enum, as workspaces.status is: comparisons with text must cast.
create type workspace_status as enum (
  'creating', 'provisioning', 'ready', 'idle', 'suspending', 'resuming', 'suspended',
  'destroying', 'destroyed', 'archiving', 'archived', 'restoring', 'failed'
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid,
  status workspace_status not null default 'creating',
  branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The notifications tables (20261102163000_session_notifications.sql), as
-- much of them as the Missions migrations change: their kinds.
create table session_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null
);
create table notification_preferences (
  user_id uuid primary key,
  kinds text[] not null default '{}'
);
