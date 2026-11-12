-- Delegating a Linear issue to Outrunner (docs/linear-app.md): an agent session
-- there, a session here, and what's said going both ways.
--
-- Server's alone, as 20261108120000_trackers.sql. Additive, except the check on
-- workspaces.source, which only widens.
-- ---------------------------------------------------------------------------

alter table workspaces drop constraint if exists workspaces_source_check;
alter table workspaces add constraint workspaces_source_check
  check (source in ('app', 'slack', 'automation', 'github', 'api', 'linear'));

-- Which install an item's issue is in: what writing back to it goes through.
alter table work_items add column if not exists tracker_installation_id uuid
  references tracker_installations (id) on delete set null;

create table if not exists linear_agent_sessions (
  -- Linear's id for the agent session. A new delegation of the same issue is a
  -- new row, on the same session here.
  agent_session_id text primary key check (char_length(agent_session_id) between 1 and 200),
  installation_id uuid not null references tracker_installations (id) on delete cascade,
  org_id uuid references organizations (id) on delete cascade,
  issue_id text not null check (char_length(issue_id) between 1 and 200),
  item_id uuid references work_items (id) on delete set null,
  workspace_id uuid references workspaces (id) on delete set null,
  -- Who it runs as.
  owner_id uuid references auth.users (id) on delete set null,
  -- awaiting_repo: asked which repository, nothing started.
  -- awaiting_link: asked to link their account, nothing started.
  -- working: a session answers it. stopped: un-delegated or told to stop.
  stage text not null default 'working'
    check (stage in ('awaiting_repo', 'awaiting_link', 'working', 'stopped')),
  -- What the session's first prompt was to say, kept while a question waits.
  prompt text check (char_length(prompt) <= 200000),
  -- No person delegated it: a slot of the team's day is taken when it really starts.
  rule_started boolean not null default false,
  -- What the delegation said, kept while a question waits: a reply needn't repeat it.
  ask jsonb,
  -- The Linear user asked to link, whose link carries this on.
  asked_user text,
  -- An @mention opened it, and it hasn't been delegated since. Linear reuses the session for
  -- a later delegation and says so only on the issue. Not in `ask`, which doesn't last.
  from_mention boolean not null default false,
  -- When Linear made the session: an issue change at that moment is this delegation's own.
  session_created_at timestamptz,
  -- The team it was connected through: disconnected, nothing more goes there.
  team_id text,
  -- Whether the issue was open when this asked something: only then can it have closed since.
  open_when_asked boolean not null default false,
  -- A slot of the day already spent on what's still waiting: an answer doesn't spend another.
  slot_taken boolean not null default false,
  -- New with every stop: a write made by what read the row before one doesn't land.
  stop_mark text,
  -- The last turn's end said, and until when a turn is watched.
  relayed_hash text,
  relay_until timestamptz,
  -- What a watch knows between looks (lib/session/turn-watch.ts).
  watch jsonb,
  -- When something was last said there, and which message, so a working session isn't
  -- marked stale and doesn't repeat itself.
  last_said_at timestamptz,
  said_hash text,
  -- The wait on someone already asked about.
  asked_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists linear_agent_sessions_relay_idx
  on linear_agent_sessions (relay_until) where relay_until is not null;
create index if not exists linear_agent_sessions_workspace_idx
  on linear_agent_sessions (workspace_id) where workspace_id is not null;
create index if not exists linear_agent_sessions_issue_idx
  on linear_agent_sessions (installation_id, issue_id);
create index if not exists linear_agent_sessions_asked_idx
  on linear_agent_sessions (installation_id, asked_user) where asked_user is not null;

drop trigger if exists linear_agent_sessions_set_updated_at on linear_agent_sessions;
create trigger linear_agent_sessions_set_updated_at
  before update on linear_agent_sessions
  for each row execute function set_updated_at();

alter table linear_agent_sessions enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table linear_agent_sessions from anon, authenticated;

-- Who's acting on an issue: a delegation and an @mention close together, or a delivery and
-- its retry, must not start two sessions. Runs out, so a crash doesn't hold it for good.
create table if not exists tracker_issue_claims (
  installation_id uuid not null references tracker_installations (id) on delete cascade,
  issue_id text not null check (char_length(issue_id) between 1 and 200),
  holder text not null,
  until timestamptz not null,
  primary key (installation_id, issue_id)
);

alter table tracker_issue_claims enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table tracker_issue_claims from anon, authenticated;

-- Hold an issue, in one statement. Null: it's held now. Otherwise, who has it.
create or replace function claim_tracker_issue(target_installation uuid, target_issue text, claimant text, hold_seconds integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  taken boolean;
  current_holder text;
begin
  insert into public.tracker_issue_claims as held (installation_id, issue_id, holder, until)
  values (target_installation, target_issue, claimant, now() + make_interval(secs => hold_seconds))
  on conflict (installation_id, issue_id) do update
    set holder = excluded.holder, until = excluded.until
    where held.until < now()
  returning true into taken;
  if coalesce(taken, false) then
    return null;
  end if;
  select holder into current_holder
  from public.tracker_issue_claims
  where installation_id = target_installation and issue_id = target_issue;
  return current_holder;
end;
$$;

revoke all on function claim_tracker_issue(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function claim_tracker_issue(uuid, text, text, integer) to service_role;

-- Take one of today's rule-started sessions for a team, in one update, so two at
-- once can't both take the last. False at the cap. Days are UTC.
create or replace function claim_rule_session(target_scope uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  taken boolean;
begin
  update public.tracker_scopes
  set rule_sessions_count = case when rule_sessions_on is distinct from today then 1 else rule_sessions_count + 1 end,
      rule_sessions_on = today
  where id = target_scope
    and (rule_sessions_on is distinct from today or rule_sessions_count < rule_sessions_per_day)
  returning true into taken;
  return coalesce(taken, false);
end;
$$;

revoke all on function claim_rule_session(uuid) from public, anon, authenticated;
grant execute on function claim_rule_session(uuid) to service_role;
