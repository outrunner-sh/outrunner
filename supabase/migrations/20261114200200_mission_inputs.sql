-- More inputs to a Mission (docs/missions.md, "Triggers"): automations whose
-- destination is a Mission rather than a new session. A run of one makes a
-- Mission request (mission_slack_requests, its outbox), never a session.
-- Their triggers: a schedule, a webhook, a watched Slack channel, and Linear
-- issues routed to the Mission. On top of 20261114200100_mission_slack_
-- reliability.sql, additive only: every existing automation is a session's,
-- as before, and runs as before.
-- ---------------------------------------------------------------------------

-- Where an automation's runs go. A Mission target names its Mission, and its
-- one repository is that Mission's project's (set by the app).
alter table automations add column if not exists target_kind text not null default 'session';
alter table automations add column if not exists target_mission_id uuid references workspaces (id) on delete cascade;
-- A watched Slack channel: which, and the filter prompt a message must pass
-- (a restricted model call with no tools). Apps' messages are heard only
-- from these app ids; Outrunner's own never.
alter table automations add column if not exists watch_team_id text;
alter table automations add column if not exists watch_channel_id text;
alter table automations add column if not exists filter_prompt text;
alter table automations add column if not exists allowed_app_ids text[] not null default '{}';
-- Linear issues routed to the Mission: these teams (Linear's ids), and the
-- automation's `labels` as a filter.
alter table automations add column if not exists linear_team_ids text[] not null default '{}';
-- A webhook's optional HMAC secret, sealed (lib/crypto/secret-box.ts).
alter table automations add column if not exists webhook_hmac_sealed text;

alter table automations drop constraint if exists automations_target_check;
alter table automations add constraint automations_target_check check (
  (target_kind = 'session' and target_mission_id is null)
  or (target_kind = 'mission' and target_mission_id is not null)
) not valid;
alter table automations validate constraint automations_target_check;

alter table automations drop constraint if exists automations_inputs_check;
alter table automations add constraint automations_inputs_check check (
  (filter_prompt is null or char_length(filter_prompt) between 1 and 2000)
  and (watch_team_id is null or watch_team_id ~ '^[A-Z0-9]{2,32}$')
  and (watch_channel_id is null or watch_channel_id ~ '^[CG][A-Z0-9]{2,32}$')
  and cardinality(allowed_app_ids) <= 20
  and cardinality(linear_team_ids) <= 20
  -- The Mission's own triggers are a Mission's only; a Mission's are these.
  and (target_kind = 'mission' or not (triggers && array['slack.message', 'linear.issue']))
  and (target_kind = 'session' or triggers <@ array['schedule', 'webhook', 'slack.message', 'linear.issue'])
  and (not ('slack.message' = any (triggers)) or (watch_team_id is not null and watch_channel_id is not null and filter_prompt is not null))
  and (not ('linear.issue' = any (triggers)) or cardinality(linear_team_ids) > 0)
) not valid;
alter table automations validate constraint automations_inputs_check;

alter table automations drop constraint if exists automations_triggers_check;
alter table automations add constraint automations_triggers_check
  check (cardinality(triggers) > 0 and triggers <@ array[
    'pull_request.opened', 'pull_request.synchronize', 'pull_request.closed', 'pull_request.merged',
    'pull_request.review_requested', 'issues.opened', 'issues.labeled', 'schedule', 'webhook',
    'slack.message', 'linear.issue'
  ]) not valid;
alter table automations validate constraint automations_triggers_check;

create index if not exists automations_target_mission_idx on automations (target_mission_id) where target_mission_id is not null;
create index if not exists automations_watch_idx on automations (watch_team_id, watch_channel_id) where watch_channel_id is not null;

-- A run's trigger may be the new ones; and a Mission's run that does nothing
-- (its filter didn't match, the Mission is paused, the message was taken)
-- is `skipped`, with why.
alter table automation_runs drop constraint if exists automation_runs_trigger_check;
alter table automation_runs add constraint automation_runs_trigger_check
  check (trigger is null or trigger in (
    'pull_request.opened', 'pull_request.synchronize', 'pull_request.closed', 'pull_request.merged',
    'pull_request.review_requested', 'issues.opened', 'issues.labeled', 'schedule', 'webhook',
    'slack.message', 'linear.issue'
  )) not valid;
alter table automation_runs validate constraint automation_runs_trigger_check;
alter table automation_runs drop constraint if exists automation_runs_status_check;
alter table automation_runs add constraint automation_runs_status_check
  check (status in ('queued', 'started', 'ready', 'failed', 'refused', 'skipped')) not valid;
alter table automation_runs validate constraint automation_runs_status_check;
-- The Mission request a run made.
alter table automation_runs add column if not exists mission_request_key text;

-- An unattended trigger sends work to a Mission only under its owner's
-- approval: one an automation, approved by whoever owns the Mission when it
-- runs (an owner's own are approved as they're made). Revoked, or the
-- Mission's owner changed, its runs are refused.
create table if not exists mission_delegations (
  automation_id uuid primary key references automations (id) on delete cascade,
  mission_id uuid not null references workspaces (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_at is null or approved_by is not null)
);

create index if not exists mission_delegations_mission_idx on mission_delegations (mission_id);

-- A request's source, and how it stands: one from a watched channel, a
-- webhook, a schedule or Linear, beside Slack's own. Linear's carries its
-- issue and agent session, for its updates and replies. Cancelled: its
-- issue closed or was taken back, so its Ships take no more work for it.
-- `announced_at`: the Mission was told of it (after its root post, if any).
alter table mission_slack_requests add column if not exists source text not null default 'slack';
alter table mission_slack_requests add column if not exists status text not null default 'open';
alter table mission_slack_requests add column if not exists title text check (char_length(title) <= 300);
alter table mission_slack_requests add column if not exists external_ref text check (char_length(external_ref) <= 200);
alter table mission_slack_requests add column if not exists external_session text check (char_length(external_session) <= 200);
alter table mission_slack_requests add column if not exists installation_id uuid;
alter table mission_slack_requests add column if not exists automation_id uuid references automations (id) on delete set null;
alter table mission_slack_requests add column if not exists announced_at timestamptz;
-- What the Mission is told of it: its text, who and where from (kept, so a
-- request the tick tells late says the same).
alter table mission_slack_requests add column if not exists details jsonb;
alter table mission_slack_requests drop constraint if exists mission_slack_requests_source_check;
alter table mission_slack_requests add constraint mission_slack_requests_source_check
  check (source in ('slack', 'slack_watch', 'webhook', 'schedule', 'linear')) not valid;
alter table mission_slack_requests validate constraint mission_slack_requests_source_check;
alter table mission_slack_requests drop constraint if exists mission_slack_requests_status_check;
alter table mission_slack_requests add constraint mission_slack_requests_status_check
  check (status in ('open', 'cancelled')) not valid;
alter table mission_slack_requests validate constraint mission_slack_requests_status_check;
create index if not exists mission_slack_requests_external_idx
  on mission_slack_requests (source, external_session) where external_session is not null;
create index if not exists mission_slack_requests_unannounced_idx
  on mission_slack_requests (created_at) where announced_at is null and source <> 'slack';

-- The Mission hears of a request's updates and cancellation, beside the
-- request itself.
alter table mission_events drop constraint if exists mission_events_kind_check;
alter table mission_events add constraint mission_events_kind_check
  check (kind in (
    'finished', 'ready', 'needs_attention', 'merged', 'closed', 'archived',
    'slack_request', 'slack_answer', 'slack_channel',
    'request', 'request_update', 'request_cancelled'
  )) not valid;
alter table mission_events validate constraint mission_events_kind_check;
alter table mission_events drop constraint if exists mission_events_runner_check;
alter table mission_events add constraint mission_events_runner_check
  check (runner_id is not null or kind in (
    'slack_request', 'slack_answer', 'slack_channel', 'request', 'request_update', 'request_cancelled'
  )) not valid;
alter table mission_events validate constraint mission_events_runner_check;

-- A request's root post: a new message in the Mission's bound channel, the
-- request's thread once it's posted. A post with no thread yet is that.
alter table mission_slack_posts alter column thread_ts drop not null;
alter table mission_slack_posts drop constraint if exists mission_slack_posts_kind_check;
alter table mission_slack_posts add constraint mission_slack_posts_kind_check
  check (kind in ('reply', 'ask', 'reaction', 'card', 'root')) not valid;
alter table mission_slack_posts validate constraint mission_slack_posts_kind_check;
alter table mission_slack_posts drop constraint if exists mission_slack_posts_root_check;
alter table mission_slack_posts add constraint mission_slack_posts_root_check
  check ((kind = 'root') = (thread_ts is null)) not valid;
alter table mission_slack_posts validate constraint mission_slack_posts_root_check;
-- The request a root post opens.
alter table mission_slack_posts add column if not exists request_key text;

-- One Slack message is one request anywhere: whichever of the bound
-- channel's route and the watches takes it first has it; the rest skip it.
create table if not exists mission_slack_message_claims (
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{2,32}$'),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,32}$'),
  message_ts text not null check (message_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  mission_id uuid not null references workspaces (id) on delete cascade,
  source text not null check (source in ('slack', 'slack_watch')),
  claim_key text not null check (char_length(claim_key) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (slack_team_id, channel_id, message_ts)
);

-- A Mission's reply to Linear, claimed before it's sent: once a key.
create table if not exists mission_linear_replies (
  op_key text primary key check (char_length(op_key) between 1 and 300),
  mission_id uuid not null references workspaces (id) on delete cascade,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  created_at timestamptz not null default now()
);

-- Make a Mission's automation: create_automation's work, with its target
-- and inputs in the same insert (its checks hold the row whole, so they
-- can't come after). A Mission's target doesn't change once made.
create or replace function create_mission_automation(
  target_org uuid,
  runner uuid,
  automation_name text,
  automation_template text,
  automation_prompt text,
  automation_triggers text[],
  is_enabled boolean,
  project_ids uuid[],
  settings jsonb,
  inputs jsonb
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
    labels, max_runs, archive_when_done, debounce_seconds, session_mode,
    target_kind, target_mission_id, watch_team_id, watch_channel_id, filter_prompt,
    allowed_app_ids, linear_team_ids, webhook_hmac_sealed
  )
  values (
    target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled,
    coalesce(array(select jsonb_array_elements_text(settings->'labels')), '{}'),
    (settings->>'max_runs')::integer,
    coalesce((settings->>'archive_when_done')::boolean, false),
    coalesce((settings->>'debounce_seconds')::integer, 0),
    'new',
    'mission', (inputs->>'mission_id')::uuid, inputs->>'watch_team_id', inputs->>'watch_channel_id', inputs->>'filter_prompt',
    coalesce(array(select jsonb_array_elements_text(inputs->'allowed_app_ids')), '{}'),
    coalesce(array(select jsonb_array_elements_text(inputs->'linear_team_ids')), '{}'),
    inputs->>'webhook_hmac_sealed'
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

-- Change a Mission's automation's inputs: those given (a key present with
-- null clears it, the HMAC secret's only; the watch and Linear teams are
-- kept while their trigger may need them).
create or replace function set_mission_automation_inputs(target_org uuid, automation uuid, inputs jsonb)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update automations set
    watch_team_id = case when inputs ? 'watch_team_id' then inputs->>'watch_team_id' else watch_team_id end,
    watch_channel_id = case when inputs ? 'watch_channel_id' then inputs->>'watch_channel_id' else watch_channel_id end,
    filter_prompt = case when inputs ? 'filter_prompt' then inputs->>'filter_prompt' else filter_prompt end,
    allowed_app_ids = case when inputs ? 'allowed_app_ids'
      then coalesce(array(select jsonb_array_elements_text(inputs->'allowed_app_ids')), '{}') else allowed_app_ids end,
    linear_team_ids = case when inputs ? 'linear_team_ids'
      then coalesce(array(select jsonb_array_elements_text(inputs->'linear_team_ids')), '{}') else linear_team_ids end,
    webhook_hmac_sealed = case when inputs ? 'webhook_hmac_sealed' then inputs->>'webhook_hmac_sealed' else webhook_hmac_sealed end,
    updated_at = now()
  where id = automation and org_id = target_org and target_kind = 'mission';
  return found;
end;
$$;

revoke all on function create_mission_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function create_mission_automation(uuid, uuid, text, text, text, text[], boolean, uuid[], jsonb, jsonb) to service_role;
revoke all on function set_mission_automation_inputs(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function set_mission_automation_inputs(uuid, uuid, jsonb) to service_role;

alter table mission_delegations enable row level security;
alter table mission_slack_message_claims enable row level security;
alter table mission_linear_replies enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_delegations from anon, authenticated;
revoke all on table mission_slack_message_claims from anon, authenticated;
revoke all on table mission_linear_replies from anon, authenticated;
