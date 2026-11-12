-- Jira's side of delegation (docs/jira-app.md): assigning an issue to the install's
-- service account, or @mentioning it, runs a session. Jira has no agent sessions, so
-- this keeps what linear_agent_sessions keeps, per issue.
--
-- Server's alone, as 20261108120000_trackers.sql. Additive.
-- ---------------------------------------------------------------------------

create table if not exists jira_issue_sessions (
  installation_id uuid not null references tracker_installations (id) on delete cascade,
  issue_id text not null check (char_length(issue_id) between 1 and 200),
  org_id uuid references organizations (id) on delete cascade,
  item_id uuid references work_items (id) on delete set null,
  workspace_id uuid references workspaces (id) on delete set null,
  owner_id uuid references auth.users (id) on delete set null,
  stage text not null default 'working'
    check (stage in ('awaiting_repo', 'awaiting_link', 'working', 'stopped')),
  prompt text check (char_length(prompt) <= 200000),
  -- The comment that prompt quotes: edited or deleted, the prompt goes too.
  comment_id text,
  -- The Jira user asked to link, whose link carries this on.
  asked_user text,
  -- What they said, kept apart from the prompt: only their own words can name a repository.
  ask_text text check (char_length(ask_text) <= 200000),
  -- The project it was connected through: disconnected, nothing more goes there.
  team_id text,
  -- Whether the issue was open when this asked something: only then can it have closed since.
  open_when_asked boolean not null default false,
  -- A slot of the day already spent on what's still waiting: an answer doesn't spend another.
  slot_taken boolean not null default false,
  -- New with every stop: a write made by what read the row before one doesn't land.
  stop_mark text,
  -- No person asked: a slot of the project's day is taken when it really starts.
  rule_started boolean not null default false,
  relayed_hash text,
  relay_until timestamptz,
  -- What a watch knows between looks (lib/session/turn-watch.ts).
  watch jsonb,
  -- The wait on someone already asked about.
  asked_digest text,
  -- Held while one event decides what to do: an assign and an @mention arriving together
  -- mustn't start two sessions. Runs out, so a crash doesn't hold the issue for good.
  claim_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (installation_id, issue_id)
);

create index if not exists jira_issue_sessions_relay_idx
  on jira_issue_sessions (relay_until) where relay_until is not null;
create index if not exists jira_issue_sessions_workspace_idx
  on jira_issue_sessions (workspace_id) where workspace_id is not null;
create index if not exists jira_issue_sessions_asked_idx
  on jira_issue_sessions (installation_id, asked_user) where asked_user is not null;

drop trigger if exists jira_issue_sessions_set_updated_at on jira_issue_sessions;
create trigger jira_issue_sessions_set_updated_at
  before update on jira_issue_sessions
  for each row execute function set_updated_at();

alter table jira_issue_sessions enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table jira_issue_sessions from anon, authenticated;

-- Who an install acts as, by name: anything assigned to or mentioning that account starts a
-- session, so settings have to be able to say who it is.
alter table tracker_installations add column if not exists app_user_name text;

alter table workspaces drop constraint if exists workspaces_source_check;
alter table workspaces add constraint workspaces_source_check
  check (source in ('app', 'slack', 'automation', 'github', 'api', 'linear', 'jira'));
