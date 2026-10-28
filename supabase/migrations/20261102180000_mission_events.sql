-- What fills a Mission's outbox (20261102170000_missions.sql): its Runners'
-- turns ending, and their pull requests settling, merging or closing
-- (docs/missions.md).
-- ---------------------------------------------------------------------------

-- A turn being watched for its end (lib/session/turn-watch.ts): from a send
-- until the agent's turn is over, seen twice apart so a pause between tool
-- calls isn't taken for an end. Kept here, not in the server's memory, so a
-- restart, or the box pausing and resuming, loses nothing: the tick carries
-- on where the watch after the send left off.
create table if not exists turn_watches (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  -- Who watches: a Mission, for its Runner's turn.
  purpose text not null check (purpose in ('runner')),
  -- When what started the turn was sent, by our clock: the event's key.
  sent_at timestamptz not null,
  -- The session's last activity just before the send, by its box's clock:
  -- activity after it is this turn's, whatever the two clocks say. Null when
  -- its box couldn't be read (a new session's).
  baseline_activity timestamptz,
  -- The agent was seen mid-turn since the send.
  seen_working boolean not null default false,
  -- First seen not mid-turn, with a reply, after the send: the end, once
  -- confirmed by a second look.
  quiet_since timestamptz,
  -- The box's last-activity stamp then: unmoved on the second look, it ended.
  quiet_activity text,
  -- Its newest reply as last read, for when its box sleeps before the end
  -- is confirmed.
  last_message text check (char_length(last_message) <= 200000),
  -- Its box first failed to answer, for telling a box that died.
  unreachable_since timestamptz,
  checked_at timestamptz
);

create index if not exists turn_watches_checked_idx on turn_watches (checked_at nulls first);

alter table turn_watches enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table turn_watches from anon, authenticated;

-- A Runner's pull requests, as the settler follows them
-- (lib/missions/settle.ts): every one opened from a branch of the Runner's,
-- so several a Runner, and stacked ones, each on its own. Activity on one
-- (a push, CI, a review) starts a stretch; once it has been quiet three
-- minutes it's decided, ready or needing attention, and a decision that
-- changes (or a new head) is reported to the Mission once (decision_seq).
create table if not exists runner_pull_requests (
  runner_id uuid not null references workspaces (id) on delete cascade,
  repo text not null check (repo ~ '^[^/\s]+/[^/\s]+$'),
  number integer not null check (number > 0),
  url text not null,
  title text not null default '',
  head_ref text not null,
  base_ref text,
  head_sha text,
  state text not null default 'open' check (state in ('open', 'merged', 'closed')),
  -- The current stretch of activity: since when, and its latest.
  first_activity_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  -- The stretch's decision: null until it settles.
  verdict text check (verdict in ('ready', 'needs_attention')),
  verdict_reason text,
  -- The last decision reported, and on which head: a new one is reported only
  -- when either changes.
  reported_verdict text,
  reported_sha text,
  decision_seq integer not null default 0,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (runner_id, repo, number)
);

create index if not exists runner_pull_requests_open_idx
  on runner_pull_requests (checked_at nulls first) where state = 'open';
create index if not exists runner_pull_requests_repo_idx on runner_pull_requests (lower(repo), number);

alter table runner_pull_requests enable row level security;
revoke all on table runner_pull_requests from anon, authenticated;
