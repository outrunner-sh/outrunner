-- Where each session stands (lib/session/standing.ts): needs you, working, in
-- review, done or backlog. Worked out on the server from what is recorded
-- here, so every tab, the Mac app and the sidebar agree on it.
-- ---------------------------------------------------------------------------

-- What a session's agent is doing, as its conversation stream last read
-- (lib/session/watch.ts): written by the server alone, read by its owner.
create table if not exists session_activity (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Mid-turn, or between turns.
  turn text not null default 'idle' check (turn in ('working', 'idle')),
  turn_started_at timestamptz,
  -- What the agent waits on the user for, and since when: a question
  -- (ask_user), a plan to approve (ExitPlanMode), secrets (request_secrets).
  waiting text check (waiting in ('question', 'plan', 'secrets')),
  waiting_tool_id text,
  waiting_since timestamptz,
  -- The last turn that ended in a reply: when, and its opening words.
  replied_at timestamptz,
  reply_preview text,
  -- When the stream last showed anything: a turn with nothing new for long
  -- is stuck.
  event_at timestamptz,
  -- Where reading the stream left off (the JSONL byte offset it gives as an
  -- event id), and on which box: a session restored onto another box reads
  -- its log from the start.
  stream_cursor bigint not null default 0,
  stream_box text,
  -- Until when the tick reads it, after something was sent to it.
  watch_until timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table session_activity enable row level security;

drop policy if exists session_activity_owner_read on session_activity;
create policy session_activity_owner_read on session_activity
  for select using (auth.uid() = owner_id);

-- Each person's own marks on a session: pinned, moved by hand to a group,
-- and when they last saw it (a reply since is unread).
create table if not exists session_marks (
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references workspaces (id) on delete cascade,
  pinned_at timestamptz,
  moved_to text check (moved_to in ('needs_you', 'working', 'in_review', 'done', 'backlog')),
  moved_at timestamptz,
  seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

alter table session_marks enable row level security;

drop policy if exists session_marks_own on session_marks;
create policy session_marks_own on session_marks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- A session's pull request as GitHub last said (the webhook, or the tick's
-- check): open, closed or merged, and since when.
alter table pull_requests add column if not exists state text not null default 'open';
alter table pull_requests add column if not exists state_at timestamptz;
alter table pull_requests add column if not exists checked_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pull_requests_state_check') then
    alter table pull_requests add constraint pull_requests_state_check
      check (state in ('open', 'closed', 'merged'));
  end if;
end $$;

create index if not exists pull_requests_open_idx
  on pull_requests (checked_at nulls first) where state = 'open';
