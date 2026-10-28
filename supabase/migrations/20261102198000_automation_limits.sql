-- Automations: more GitHub events, and limits on how they run.
--
-- New triggers: a pull request closed without merging, merged, or a review
-- requested of chosen people or teams (`reviewers`); an issue opened, or
-- labeled (with one of `labels`, or any). The Outrunner GitHub App's webhook
-- starts them as it does the others (lib/automations/github-events.ts).
--
-- Limits, each the automation's:
-- - `max_runs`: it runs that many times (1, run once), then switches itself
--   off, and archives itself too with `archive_when_done`. A time it runs is
--   one key (automation_runs.dedupe_key): one event, or one schedule's time,
--   is one however many repositories it runs on. Counted from `runs_since`,
--   which moves when the limit changes or it's switched back on.
-- - `debounce_seconds`: triggers that come within the window of each other
--   on the same thing (`subject`: a pull request, an issue, the schedule,
--   the webhook) are one run, of the last of them, once the window passes
--   with no other. It waits `queued`, until `not_before`; `combined` says
--   how many it took in, and `absorbed_keys` keeps their keys, which record
--   nothing again.
-- - `session_mode`: 'new', a session each run as before, or 'reuse', the
--   automation's last session on the same thing (`subject`) in the
--   repository, given the run's prompt.
--
-- record_automation_runs records a batch of runs in one transaction, each
-- automation locked while it's counted, so two events at once never run it
-- past its limit, nor start two runs of what a window combines.
-- ---------------------------------------------------------------------------

alter table automations add column if not exists reviewers text[] not null default '{}';
alter table automations add column if not exists labels text[] not null default '{}';
alter table automations add column if not exists max_runs integer;
alter table automations add column if not exists archive_when_done boolean not null default false;
alter table automations add column if not exists debounce_seconds integer not null default 0;
alter table automations add column if not exists session_mode text not null default 'new';
alter table automations add column if not exists archived_at timestamptz;
alter table automations add column if not exists runs_since timestamptz not null default now();

alter table automations drop constraint if exists automations_limits_check;
alter table automations add constraint automations_limits_check check (
  (max_runs is null or max_runs between 1 and 10000)
  and debounce_seconds between 0 and 3600
  and session_mode in ('new', 'reuse')
  and cardinality(reviewers) <= 20
  and cardinality(labels) <= 20
  -- Archived is done: never on.
  and (archived_at is null or not enabled)
);

-- Review requests start it only of the people or teams it names: with the
-- trigger and none named, it would never run. Held here, on what's saved,
-- since a change may tick the trigger without sending its reviewers.
alter table automations drop constraint if exists automations_reviewers_check;
alter table automations add constraint automations_reviewers_check
  check (not ('pull_request.review_requested' = any (triggers)) or cardinality(reviewers) > 0);

alter table automations drop constraint if exists automations_triggers_check;
alter table automations add constraint automations_triggers_check
  check (cardinality(triggers) > 0 and triggers <@ array[
    'pull_request.opened', 'pull_request.synchronize', 'pull_request.closed', 'pull_request.merged',
    'pull_request.review_requested', 'issues.opened', 'issues.labeled', 'schedule', 'webhook'
  ]);

alter table automation_runs add column if not exists issue_number integer check (issue_number > 0);
alter table automation_runs add column if not exists subject text;
alter table automation_runs add column if not exists not_before timestamptz;
alter table automation_runs add column if not exists combined integer not null default 1 check (combined >= 1);
-- The keys of the triggers a waiting run took in, beside its own (the
-- last's): each still records nothing again, a redelivery of an earlier one
-- included.
alter table automation_runs add column if not exists absorbed_keys text[] not null default '{}';

alter table automation_runs drop constraint if exists automation_runs_trigger_check;
alter table automation_runs add constraint automation_runs_trigger_check
  check (trigger is null or trigger in (
    'pull_request.opened', 'pull_request.synchronize', 'pull_request.closed', 'pull_request.merged',
    'pull_request.review_requested', 'issues.opened', 'issues.labeled', 'schedule', 'webhook'
  ));
-- queued: waiting out its debounce window, until not_before.
alter table automation_runs drop constraint if exists automation_runs_status_check;
alter table automation_runs add constraint automation_runs_status_check
  check (status in ('queued', 'started', 'ready', 'failed', 'refused'));
alter table automation_runs drop constraint if exists automation_runs_queued_check;
alter table automation_runs add constraint automation_runs_queued_check check (status <> 'queued' or not_before is not null);

-- The tick's read of the runs whose window has passed: only those waiting.
create index if not exists automation_runs_queued_idx on automation_runs (not_before) where status = 'queued';
-- A limit's count, and a reused session's look-up.
create index if not exists automation_runs_since_idx on automation_runs (automation_id, created_at);

-- The times an automation has run since its count began (`runs_since`):
-- each key once, however many repositories it ran on. What its limit is
-- held to, here and in the editor's "3 of 10 runs".
create or replace function automation_times_run(automation uuid)
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(distinct r.dedupe_key)::integer
  from automation_runs r join automations a on a.id = r.automation_id
  where r.automation_id = automation and r.created_at >= a.runs_since;
$$;

revoke all on function automation_times_run(uuid) from public, anon, authenticated;
grant execute on function automation_times_run(uuid) to service_role;

-- Record `runs` (a JSON array of {automation_id, project_id, trigger,
-- dedupe_key, subject, context, pr_number, pr_title, head_sha, issue_number,
-- scheduled_for}): the runs made, or the waiting run each was combined into,
-- and whether it waits. None of an automation that's off or archived, none
-- whose key its automation already has on the repository, and none past its
-- limit; reaching it switches the automation off (and archives it, if it's
-- to be).
create or replace function record_automation_runs(runs jsonb)
returns table (run_id uuid, run_automation_id uuid, run_project_id uuid, queued boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  a automations%rowtype;
  item jsonb;
  project uuid;
  key text;
  waiting uuid;
  made uuid;
  fired integer;
begin
  -- Locked in id order, so two batches naming the same automations wait on
  -- each other rather than deadlock.
  for a in
    select * from automations
    where id in (select (r->>'automation_id')::uuid from jsonb_array_elements(runs) r)
    order by id
    for update
  loop
    if not a.enabled or a.archived_at is not null then
      continue;
    end if;
    for item in select r from jsonb_array_elements(runs) r where (r->>'automation_id')::uuid = a.id loop
      project := (item->>'project_id')::uuid;
      key := item->>'dedupe_key';
      -- Recorded already (a redelivery, a tick sent twice), as a run's own
      -- key or one it took in: nothing.
      if exists (
        select 1 from automation_runs x
        where x.automation_id = a.id and x.project_id = project and (x.dedupe_key = key or key = any (x.absorbed_keys))
      ) then
        continue;
      end if;
      -- In a window: taken into the run waiting on the same thing, which is
      -- now this trigger's, its window started again.
      if a.debounce_seconds > 0 then
        select x.id into waiting from automation_runs x
        where x.automation_id = a.id and x.project_id = project and x.subject is not distinct from item->>'subject'
          and x.status = 'queued'
        for update;
        if found then
          update automation_runs set
            trigger = item->>'trigger',
            absorbed_keys = absorbed_keys || dedupe_key,
            dedupe_key = key,
            context = item->'context',
            pr_number = (item->>'pr_number')::integer,
            pr_title = coalesce(item->>'pr_title', ''),
            head_sha = item->>'head_sha',
            issue_number = (item->>'issue_number')::integer,
            scheduled_for = (item->>'scheduled_for')::timestamptz,
            not_before = now() + make_interval(secs => a.debounce_seconds),
            combined = combined + 1,
            updated_at = now()
          where id = waiting;
          return query select waiting, a.id, project, true;
          continue;
        end if;
      end if;
      -- Past its limit: a new time it runs, when it has run its count. The
      -- same key on another repository is the same time.
      if a.max_runs is not null then
        fired := automation_times_run(a.id);
        if fired >= a.max_runs and not exists (
          select 1 from automation_runs x
          where x.automation_id = a.id and (x.dedupe_key = key or key = any (x.absorbed_keys)) and x.created_at >= a.runs_since
        ) then
          continue;
        end if;
      end if;
      insert into automation_runs (
        automation_id, project_id, trigger, dedupe_key, subject, context, pr_number, pr_title, head_sha,
        issue_number, scheduled_for, status, not_before
      )
      values (
        a.id, project, item->>'trigger', key, item->>'subject', item->'context', (item->>'pr_number')::integer,
        coalesce(item->>'pr_title', ''), item->>'head_sha', (item->>'issue_number')::integer,
        (item->>'scheduled_for')::timestamptz,
        case when a.debounce_seconds > 0 then 'queued' else 'started' end,
        case when a.debounce_seconds > 0 then now() + make_interval(secs => a.debounce_seconds) end
      )
      on conflict (automation_id, project_id, dedupe_key) do nothing
      returning id into made;
      if made is not null then
        return query select made, a.id, project, a.debounce_seconds > 0;
      end if;
    end loop;
    -- Its limit reached: done.
    if a.max_runs is not null then
      fired := automation_times_run(a.id);
      if fired >= a.max_runs then
        update automations set
          enabled = false,
          archived_at = case when a.archive_when_done then now() else archived_at end,
          updated_at = now()
        where id = a.id;
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function record_automation_runs(jsonb) from public, anon, authenticated;
grant execute on function record_automation_runs(jsonb) to service_role;

-- As in 20261102195000_automation_webhooks.sql, and the settings above:
-- `reviewers`, `labels`, `max_runs`, `archive_when_done`, `debounce_seconds`,
-- `session_mode`, and `archived` (true archives it; false, or switching it
-- on, brings it back).
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
    reviewers, labels, max_runs, archive_when_done, debounce_seconds, session_mode
  )
  values (
    target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled,
    coalesce(array(select jsonb_array_elements_text(settings->'reviewers')), '{}'),
    coalesce(array(select jsonb_array_elements_text(settings->'labels')), '{}'),
    (settings->>'max_runs')::integer,
    coalesce((settings->>'archive_when_done')::boolean, false),
    coalesce((settings->>'debounce_seconds')::integer, 0),
    coalesce(settings->>'session_mode', 'new')
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
  filters_change boolean := false;
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

