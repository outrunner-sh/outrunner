-- Just enough of the schema the Missions migrations build on, for
-- test/missions-sql.test.ts: the roles, the workspaces table's columns they
-- read, and set_updated_at (20260731090000_init.sql).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
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

-- The automations tables, as much of them as 20261114200200_mission_inputs.sql
-- changes (their checks under the names the earlier migrations give them).
create table automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  name text not null default 'a',
  prompt text not null default 'p',
  triggers text[] not null constraint automations_triggers_check
    check (cardinality(triggers) > 0 and triggers <@ array['pull_request.opened', 'schedule', 'webhook']),
  labels text[] not null default '{}',
  enabled boolean not null default true,
  runs_as uuid,
  template text,
  max_runs integer,
  archive_when_done boolean not null default false,
  debounce_seconds integer not null default 0,
  session_mode text not null default 'new',
  archived_at timestamptz,
  webhook_token_hash text,
  webhook_token_sealed text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- create_mission_automation's helpers, as no-ops: their own migrations test them.
create or replace function set_automation_repos(target_org uuid, automation uuid, project_ids uuid[]) returns void language sql as $$ select $$;
create or replace function set_automation_schedules(automation uuid, schedules jsonb) returns void language sql as $$ select $$;
create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references automations (id) on delete cascade,
  trigger text constraint automation_runs_trigger_check check (trigger is null or trigger in ('pull_request.opened', 'schedule', 'webhook')),
  status text not null default 'started' constraint automation_runs_status_check check (status in ('queued', 'started', 'ready', 'failed', 'refused'))
);
insert into automations (triggers) values ('{schedule}');
insert into automation_runs (trigger, status) values ('webhook', 'ready');
