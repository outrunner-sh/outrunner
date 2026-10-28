-- Automations on a schedule. An automation with the `schedule` trigger has
-- one or more schedules (weekly, monthly, once, or a cron expression, each
-- in an IANA time zone); the Cloudflare cron's tick (every 2 minutes,
-- app/api/automations/tick) starts a run for each that has come due, on each
-- of the automation's repositories, and moves it on to its next time.
--
-- When a schedule next fires is worked out by the server
-- (lib/automations/schedule.ts), which knows time zones, and kept here: the
-- tick reads only the schedules due. A disabled automation's schedules keep
-- no next time; switching it on works them out again from then, so it never
-- catches up on what it would have run while off.
--
-- Runs are no longer only a pull request's. Each now keeps what started it
-- (`trigger`, and the event its session was told, `context`, to start it
-- again as it would have been) and a key that makes it once
-- (`dedupe_key`): a pull request's commit as before (`pr:<number>:<sha>`), a
-- schedule's time (`schedule:<instant>`). A tick that runs twice, or one
-- that comes late, records the same key, and starts nothing twice.
-- ---------------------------------------------------------------------------

alter table automations drop constraint if exists automations_triggers_check;
alter table automations add constraint automations_triggers_check
  check (cardinality(triggers) > 0 and triggers <@ array['pull_request.opened', 'pull_request.synchronize', 'schedule']);

create table if not exists automation_schedules (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations (id) on delete cascade,
  -- Its place in the editor's list.
  position smallint not null default 0,
  kind text not null check (kind in ('weekly', 'monthly', 'once', 'cron')),
  timezone text not null check (char_length(timezone) between 1 and 64),
  -- weekly: {days, time}; monthly: {day, time}; once: {at}; cron: {expression}.
  spec jsonb not null,
  -- When it fires next; null when it won't (a once that's passed, or its
  -- automation off).
  next_run_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists automation_schedules_automation_idx on automation_schedules (automation_id, position);
-- The tick's read, every 2 minutes: only the schedules with a next time.
create index if not exists automation_schedules_due_idx on automation_schedules (next_run_at) where next_run_at is not null;

alter table automation_schedules enable row level security;
revoke all on table automation_schedules from anon, authenticated;

alter table automation_runs alter column pr_number drop not null;
alter table automation_runs alter column head_sha drop not null;
alter table automation_runs add column if not exists trigger text;
alter table automation_runs add column if not exists dedupe_key text;
alter table automation_runs add column if not exists scheduled_for timestamptz;
alter table automation_runs add column if not exists context jsonb;

-- The runs so far were each a pull request's commit, which was their key.
update automation_runs set dedupe_key = 'pr:' || pr_number || ':' || head_sha where dedupe_key is null;
alter table automation_runs alter column dedupe_key set not null;
alter table automation_runs drop constraint if exists automation_runs_automation_id_project_id_pr_number_head_sha_key;
alter table automation_runs drop constraint if exists automation_runs_dedupe_key_key;
alter table automation_runs add constraint automation_runs_dedupe_key_key unique (automation_id, project_id, dedupe_key);
-- A pull request's run has both; any other, neither.
alter table automation_runs drop constraint if exists automation_runs_pull_request_check;
alter table automation_runs add constraint automation_runs_pull_request_check check ((pr_number is null) = (head_sha is null));
-- Null for runs from before triggers were kept: a pull request's.
alter table automation_runs drop constraint if exists automation_runs_trigger_check;
alter table automation_runs add constraint automation_runs_trigger_check
  check (trigger is null or trigger in ('pull_request.opened', 'pull_request.synchronize', 'schedule'));

-- The run list's filter by trigger, newest first.
create index if not exists automation_runs_trigger_idx on automation_runs (automation_id, trigger, created_at desc);

-- Set an automation's schedules to `schedules` (a JSON array of {kind,
-- timezone, spec, next_run_at}), in order.
create or replace function set_automation_schedules(automation uuid, schedules jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  delete from automation_schedules where automation_id = automation;
  insert into automation_schedules (automation_id, position, kind, timezone, spec, next_run_at)
  select automation, (item.position - 1)::smallint, item.value->>'kind', item.value->>'timezone', item.value->'spec',
    (item.value->>'next_run_at')::timestamptz
  from jsonb_array_elements(coalesce(schedules, '[]'::jsonb)) with ordinality as item (value, position);
end;
$$;

-- Both now take `settings`: what's set beside the prompt, as JSON, each key
-- given set (`schedules` here). One transaction still, as before.
drop function if exists create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[]);
drop function if exists update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[]);

create or replace function create_automation(
  target_org uuid,
  runner uuid,
  automation_name text,
  automation_template text,
  automation_prompt text,
  automation_triggers text[],
  is_enabled boolean,
  project_ids uuid[],
  settings jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  made uuid;
begin
  insert into automations (org_id, runs_as, name, template, prompt, triggers, enabled)
  values (target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled)
  returning id into made;
  perform set_automation_repos(target_org, made, project_ids);
  perform set_automation_schedules(made, settings->'schedules');
  return made;
end;
$$;

-- As before (20261030130000_automations.sql), and its schedules: changing
-- when it runs is changing what it does, so it makes `editor` its runner too.
-- Schedules sent unchanged (their next times worked out again, as switching
-- it on does) change no one.
create or replace function update_automation(
  target_org uuid,
  automation uuid,
  editor uuid,
  automation_name text,
  automation_prompt text,
  automation_triggers text[],
  is_enabled boolean,
  project_ids uuid[],
  settings jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current automations%rowtype;
  repos_change boolean := false;
  schedules_change boolean := false;
begin
  -- Locked, so two changes to one automation run one after the other.
  select * into current from automations where id = automation and org_id = target_org for update;
  if not found then
    return false;
  end if;
  if project_ids is not null then
    repos_change := array(select distinct unnest(project_ids) order by 1)
      is distinct from array(select project_id from automation_repos where automation_id = automation order by 1);
  end if;
  if settings ? 'schedules' then
    schedules_change := (
      select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'timezone', s.timezone, 'spec', s.spec) order by s.position), '[]'::jsonb)
      from automation_schedules s where s.automation_id = automation
    ) is distinct from (
      select coalesce(jsonb_agg(jsonb_build_object('kind', item.value->>'kind', 'timezone', item.value->>'timezone', 'spec', item.value->'spec') order by item.position), '[]'::jsonb)
      from jsonb_array_elements(coalesce(settings->'schedules', '[]'::jsonb)) with ordinality as item (value, position)
    );
  end if;
  update automations set
    name = coalesce(automation_name, name),
    prompt = coalesce(automation_prompt, prompt),
    triggers = coalesce(automation_triggers, triggers),
    enabled = coalesce(is_enabled, enabled),
    runs_as = case
      when coalesce(automation_prompt, current.prompt) is distinct from current.prompt
        or array(select distinct unnest(coalesce(automation_triggers, current.triggers)) order by 1)
          is distinct from array(select distinct unnest(current.triggers) order by 1)
        or repos_change
        or schedules_change
        -- And whenever its runner is gone or no longer in the org, on a
        -- save of what it does (an editor's Save sends its repositories),
        -- never on a rename or the on/off switch alone.
        or (
          (automation_prompt is not null or automation_triggers is not null or project_ids is not null)
          and not exists (
            select 1 from organization_members m where m.org_id = target_org and m.user_id = current.runs_as
          )
        )
      then editor
      else runs_as
    end,
    updated_at = now()
  where id = automation;
  if project_ids is not null then
    -- Even unchanged: it checks every repository is still the org's.
    perform set_automation_repos(target_org, automation, project_ids);
  end if;
  if settings ? 'schedules' then
    perform set_automation_schedules(automation, settings->'schedules');
  end if;
  return true;
end;
$$;

revoke all on function set_automation_schedules(uuid, jsonb) from public, anon, authenticated;
revoke all on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
revoke all on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
grant execute on function set_automation_schedules(uuid, jsonb) to service_role;
grant execute on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) to service_role;
grant execute on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) to service_role;
