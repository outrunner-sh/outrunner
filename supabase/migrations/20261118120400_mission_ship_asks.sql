-- A Ship's ask_user question, as a card in the Slack thread of the request
-- that started it (lib/missions/ship-ask.ts, docs/missions.md "Ships'
-- questions in Slack"). One card a call: its key is the call's identity
-- (callId, launchEpoch), so a re-read of the same wait posts nothing more.
-- A button answers that exact call (lib/runtime/answer-question.ts). The
-- first click is claimed here before the answer goes; a card whose call is
-- over (answered in the app, the Ship moved on) is closed, never answered.
create table if not exists mission_ship_asks (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  runner_id uuid not null references workspaces (id) on delete cascade,
  thread_id uuid not null references mission_threads (id) on delete cascade,
  -- The binding it was posted under (mission_channels.revision): a click
  -- under another is refused.
  binding_revision uuid not null,
  op_key text not null unique check (char_length(op_key) between 1 and 300),
  call_id text not null check (char_length(call_id) between 1 and 200),
  launch_epoch text not null check (char_length(launch_epoch) between 1 and 200),
  -- The transcript's tool_use the watch saw waiting.
  tool_use_id text check (char_length(tool_use_id) <= 200),
  title text not null check (char_length(title) between 1 and 300),
  question text not null check (char_length(question) between 1 and 2900),
  -- One button each; none when the call can't be answered by one click
  -- (several questions, or several picks): the card links to the Ship.
  options text[] not null check (cardinality(options) <= 10),
  -- The questions as the agent asked them, sent back with the answer.
  questions jsonb not null,
  message_ts text,
  answer text check (char_length(answer) <= 2000),
  answered_by uuid references auth.users (id) on delete set null,
  answered_by_slack text check (char_length(answered_by_slack) <= 32),
  answered_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (runner_id, call_id, launch_epoch)
);

create index if not exists mission_ship_asks_open_idx on mission_ship_asks (runner_id) where answered_at is null and closed_at is null;
create index if not exists mission_ship_asks_tool_idx on mission_ship_asks (runner_id, tool_use_id);

alter table mission_ship_asks enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_ship_asks from anon, authenticated;
