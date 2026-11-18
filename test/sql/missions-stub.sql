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
-- much of them as the Missions migrations change: their kinds, with their
-- checks as that migration names them, so a wrong name in the Missions
-- migration's drop leaves the old check and fails the tests.
create table session_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('turn_done', 'needs_input', 'errored', 'pr_opened', 'pr_merged'))
);
create table notification_preferences (
  user_id uuid primary key,
  kinds text[] not null default '{turn_done,needs_input,errored,pr_opened,pr_merged}'
    check (kinds <@ array['turn_done', 'needs_input', 'errored', 'pr_opened', 'pr_merged'])
);
-- Someone who chose pull requests' news, and someone who didn't, from
-- before the Missions migration.
insert into notification_preferences (user_id, kinds) values
  ('00000000-0000-0000-0000-0000000000a1', '{turn_done,pr_opened}'),
  ('00000000-0000-0000-0000-0000000000a2', '{turn_done}');

-- What the Slack binding tables point at (20261118110000_mission_slack.sql):
-- an org, and a person.
create table organizations (id uuid primary key default gen_random_uuid());
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid());
