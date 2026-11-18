-- An automation's own model.
--
-- `model_provider`, `model_id` and `model_effort`: what its runs start on,
-- as a session's request names it (lib/runtime/session-models.ts: a
-- provider, its model, and the effort picked with it; none, the model's
-- own). Null, as before: the org's choice (`automations_on_harness`,
-- 20261114140000_automation_cover_new_repos.sql), Outrunner's models or the
-- runner's default. A run whose model isn't on its runner's menu starts on
-- that instead, and says so (lib/automations/runs.ts). Which providers and
-- models there are is the server's to check (lib/automations/rules.ts):
-- here only their shape, so a provider added later needs no migration.
--
-- create_automation and update_automation take it as `settings.model`:
-- `{ provider, id, effort }`, or null to clear it. Choosing one is choosing
-- whose account or allowance pays for its runs, so changing it makes
-- `editor` its runner, as changing what it does does.
-- ---------------------------------------------------------------------------

alter table automations add column if not exists model_provider text;
alter table automations add column if not exists model_id text;
alter table automations add column if not exists model_effort text;

alter table automations drop constraint if exists automations_model_check;
alter table automations add constraint automations_model_check check (
  (model_provider is null) = (model_id is null)
  and (model_provider is null or model_provider ~ '^[a-z][a-z0-9_-]{0,39}$')
  and (model_id is null or (char_length(model_id) between 1 and 100 and model_id !~ '^-'))
  and (model_effort is null or (model_id is not null and model_effort in ('low', 'medium', 'high', 'xhigh', 'max')))
);

-- As in 20261114140000_automation_cover_new_repos.sql, and `settings.model`.
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
  insert into automations (
    org_id, runs_as, name, template, prompt, triggers, enabled,
    reviewers, labels, max_runs, archive_when_done, debounce_seconds, session_mode, cover_new_repos,
    model_provider, model_id, model_effort
  )
  values (
    target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled,
    coalesce(array(select jsonb_array_elements_text(settings->'reviewers')), '{}'),
    coalesce(array(select jsonb_array_elements_text(settings->'labels')), '{}'),
    (settings->>'max_runs')::integer,
    coalesce((settings->>'archive_when_done')::boolean, false),
    coalesce((settings->>'debounce_seconds')::integer, 0),
    coalesce(settings->>'session_mode', 'new'),
    coalesce((settings->>'cover_new_repos')::boolean, false),
    settings->'model'->>'provider',
    settings->'model'->>'id',
    settings->'model'->>'effort'
  )
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

-- As in 20261114140000_automation_cover_new_repos.sql, and `settings.model`
-- (null clears it), which changes its runner when it changes.
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
  filters_change boolean := false;
  cover_change boolean := false;
  model_change boolean := false;
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
  -- Whose review requests and which labels start it are when it runs, as
  -- its schedules are.
  filters_change :=
    (settings ? 'reviewers' and array(select lower(jsonb_array_elements_text(settings->'reviewers')) order by 1)
      is distinct from array(select lower(unnest(current.reviewers)) order by 1))
    or (settings ? 'labels' and array(select lower(jsonb_array_elements_text(settings->'labels')) order by 1)
      is distinct from array(select lower(unnest(current.labels)) order by 1));
  cover_change := settings ? 'cover_new_repos'
    and (settings->>'cover_new_repos')::boolean is distinct from current.cover_new_repos;
  model_change := settings ? 'model'
    and row(settings->'model'->>'provider', settings->'model'->>'id', settings->'model'->>'effort')
      is distinct from row(current.model_provider, current.model_id, current.model_effort);
  update automations set
    name = coalesce(automation_name, name),
    prompt = coalesce(automation_prompt, prompt),
    triggers = coalesce(automation_triggers, triggers),
    -- Archived is done, and off; switched on again, it's neither.
    enabled = case when (settings->>'archived')::boolean then false else coalesce(is_enabled, enabled) end,
    archived_at = case
      when (settings->>'archived')::boolean then coalesce(archived_at, now())
      when (settings->>'archived')::boolean is false or is_enabled then null
      else archived_at
    end,
    reviewers = case when settings ? 'reviewers' then array(select jsonb_array_elements_text(settings->'reviewers')) else reviewers end,
    labels = case when settings ? 'labels' then array(select jsonb_array_elements_text(settings->'labels')) else labels end,
    max_runs = case when settings ? 'max_runs' then (settings->>'max_runs')::integer else max_runs end,
    archive_when_done = coalesce((settings->>'archive_when_done')::boolean, archive_when_done),
    debounce_seconds = coalesce((settings->>'debounce_seconds')::integer, debounce_seconds),
    session_mode = coalesce(settings->>'session_mode', session_mode),
    cover_new_repos = coalesce((settings->>'cover_new_repos')::boolean, cover_new_repos),
    model_provider = case when settings ? 'model' then settings->'model'->>'provider' else model_provider end,
    model_id = case when settings ? 'model' then settings->'model'->>'id' else model_id end,
    model_effort = case when settings ? 'model' then settings->'model'->>'effort' else model_effort end,
    -- Its runs are counted afresh when its limit changes, and when it's
    -- switched back on (after it stopped at its limit, say).
    runs_since = case
      when (settings ? 'max_runs' and (settings->>'max_runs')::integer is distinct from current.max_runs)
        or (is_enabled and not current.enabled)
      then now()
      else runs_since
    end,
    runs_as = case
      when coalesce(automation_prompt, current.prompt) is distinct from current.prompt
        or array(select distinct unnest(coalesce(automation_triggers, current.triggers)) order by 1)
          is distinct from array(select distinct unnest(current.triggers) order by 1)
        or repos_change
        or schedules_change
        or filters_change
        or cover_change
        or model_change
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

revoke all on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
revoke all on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
grant execute on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) to service_role;
grant execute on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) to service_role;
