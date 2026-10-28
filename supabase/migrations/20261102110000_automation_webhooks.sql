-- Automations started by a webhook. An automation with the `webhook`
-- trigger has a secret URL of its own (POST /api/automations/webhook/<token>):
-- whoever holds it starts a run, on each of its repositories, with the JSON
-- they post in its session's prompt (app/api/automations/webhook).
--
-- The token is kept twice: its SHA-256, which a request is looked up by,
-- and sealed with CREDENTIALS_ENCRYPTION_KEY (lib/crypto/secret-box.ts), so
-- the org's admins can read the URL again in the editor and nothing in the
-- database alone gives it away. An admin rotates it from the editor: the old
-- URL stops working at once. It's made with the trigger, in the same
-- transaction (create_automation and update_automation's `settings.webhook`);
-- turning the trigger off keeps it, unused, and on again uses it again.
-- ---------------------------------------------------------------------------

alter table automations add column if not exists webhook_token_hash text;
alter table automations add column if not exists webhook_token_sealed text;
alter table automations drop constraint if exists automations_webhook_token_hash_key;
alter table automations add constraint automations_webhook_token_hash_key unique (webhook_token_hash);
alter table automations drop constraint if exists automations_webhook_token_check;
alter table automations add constraint automations_webhook_token_check
  check ((webhook_token_hash is null) = (webhook_token_sealed is null) and (webhook_token_hash is null or webhook_token_hash ~ '^[0-9a-f]{64}$'));

alter table automations drop constraint if exists automations_triggers_check;
alter table automations add constraint automations_triggers_check
  check (cardinality(triggers) > 0 and triggers <@ array['pull_request.opened', 'pull_request.synchronize', 'schedule', 'webhook']);

alter table automation_runs drop constraint if exists automation_runs_trigger_check;
alter table automation_runs add constraint automation_runs_trigger_check
  check (trigger is null or trigger in ('pull_request.opened', 'pull_request.synchronize', 'schedule', 'webhook'));

-- As in 20261102100000_automation_schedules.sql, and `settings.webhook`
-- ({hash, sealed}): the automation's first webhook token.
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
  if settings ? 'webhook' then
    update automations set webhook_token_hash = settings->'webhook'->>'hash', webhook_token_sealed = settings->'webhook'->>'sealed'
    where id = made;
  end if;
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
  -- Its first URL, when it's given the webhook trigger: one it has already
  -- is kept (rotating it is its own step).
  if settings ? 'webhook' then
    update automations set
      webhook_token_hash = coalesce(webhook_token_hash, settings->'webhook'->>'hash'),
      webhook_token_sealed = coalesce(webhook_token_sealed, settings->'webhook'->>'sealed')
    where id = automation;
  end if;
  return true;
end;
$$;

