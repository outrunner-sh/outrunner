-- Code Review on every repository, and automations on the runner's own
-- coding agent.
--
-- `automations.cover_new_repos`: each GitHub repository connected to the org
-- from now on joins the automation's repositories (cover_new_project, on a
-- project's insert: a repository connected again is an update, so one an
-- admin took off stays off). Only with GitHub triggers: an event runs on its
-- own repository, but a schedule or a webhook runs on all of them, which an
-- ever-growing list mustn't fan out to. REPOS_MAX (lib/automations/rules.ts)
-- doesn't hold it.
--
-- ensure_code_review: the org's Code Review automation, made (on
-- `cover_new_repos`) when a member connects repositories and the org has
-- none, from its template in any state (off, archived, or its flag unset: an
-- admin's choice, kept). lib/db/repositories.ts calls it.
--
-- `organization_settings.automations_on_harness`: the org's automations run
-- on their runner's default model and coding agent (Claude Code or Codex, on
-- their own sign-in or key) instead of Outrunner's models; a run that can't
-- start on it starts on Outrunner's, and says so (lib/session/server-session.ts).
-- ---------------------------------------------------------------------------

alter table automations add column if not exists cover_new_repos boolean not null default false;

alter table automations drop constraint if exists automations_cover_new_repos_check;
alter table automations add constraint automations_cover_new_repos_check
  check (not cover_new_repos or not (triggers && array['schedule', 'webhook']::text[]));

alter table organization_settings add column if not exists automations_on_harness boolean not null default false;

-- Code Review automations already made cover new repositories too, where
-- their triggers allow it.
update automations set cover_new_repos = true
where template = 'code-review' and not (triggers && array['schedule', 'webhook']::text[]);

-- A GitHub repository connected to an org joins the org's automations that
-- cover new repositories. Security definer: a member's own insert makes it,
-- and automation_repos is the server's alone.
create or replace function cover_new_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into automation_repos (automation_id, project_id)
  select a.id, new.id from automations a
  where a.org_id = new.org_id and a.cover_new_repos
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function cover_new_project() from public, anon, authenticated;

drop trigger if exists projects_cover_new on projects;
create trigger projects_cover_new
  after insert on projects
  for each row
  when (new.github_repo_id is not null)
  execute function cover_new_project();

-- As in 20261102198000_automation_limits.sql, and `settings.cover_new_repos`.
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
    reviewers, labels, max_runs, archive_when_done, debounce_seconds, session_mode, cover_new_repos
  )
  values (
    target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled,
    coalesce(array(select jsonb_array_elements_text(settings->'reviewers')), '{}'),
    coalesce(array(select jsonb_array_elements_text(settings->'labels')), '{}'),
    (settings->>'max_runs')::integer,
    coalesce((settings->>'archive_when_done')::boolean, false),
    coalesce((settings->>'debounce_seconds')::integer, 0),
    coalesce(settings->>'session_mode', 'new'),
    coalesce((settings->>'cover_new_repos')::boolean, false)
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

-- As in 20261102198000_automation_limits.sql, and `settings.cover_new_repos`,
-- which is which repositories it runs on: changing it makes `editor` its
-- runner, as changing them does.
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

-- The org's automation from `automation_template`, made on `project_ids`
-- (covering new repositories too) and run as `runner`, when the org has
-- none from it in any state; its id, or null when it had one. Locked on the
-- org, so two connections at once make one.
create or replace function ensure_code_review(
  target_org uuid,
  runner uuid,
  automation_name text,
  automation_template text,
  automation_prompt text,
  automation_triggers text[],
  project_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ensure_code_review:' || target_org::text, 0));
  if exists (select 1 from automations where org_id = target_org and template = automation_template) then
    return null;
  end if;
  return create_automation(
    target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, true,
    project_ids, jsonb_build_object('cover_new_repos', true)
  );
end;
$$;

revoke all on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
revoke all on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) from public, anon, authenticated;
revoke all on function ensure_code_review(uuid, uuid, text, text, text, text[], uuid[]) from public, anon, authenticated;
grant execute on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb) to service_role;
grant execute on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[], jsonb) to service_role;
grant execute on function ensure_code_review(uuid, uuid, text, text, text, text[], uuid[]) to service_role;
