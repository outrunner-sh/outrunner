-- Missions on call in Slack (docs/missions.md, "On call in Slack"): a Mission
-- bound to one Slack channel takes the requests people mention Outrunner
-- with there, through its outbox, and answers in their threads.
--
-- Additive only: new tables, two new event kinds and a nullable column. Code
-- from before this migration reads and writes nothing here, and the Slack
-- agent goes on as before in channels with no Mission. Every table is the
-- server's alone: RLS on, no policy, every grant revoked.
-- ---------------------------------------------------------------------------

-- Slack's news has no Ship: a request, an answer to a question card, or the
-- binding itself changing. The Ship stays required for the Ships' own kinds.
alter table mission_events alter column runner_id drop not null;

alter table mission_events drop constraint if exists mission_events_kind_check;
alter table mission_events add constraint mission_events_kind_check
  check (kind in (
    'finished', 'ready', 'needs_attention', 'merged', 'closed', 'archived',
    'slack_request', 'slack_answer', 'slack_channel'
  )) not valid;
alter table mission_events validate constraint mission_events_kind_check;

alter table mission_events drop constraint if exists mission_events_runner_check;
alter table mission_events add constraint mission_events_runner_check
  check (runner_id is not null or kind in ('slack_request', 'slack_answer', 'slack_channel')) not valid;
alter table mission_events validate constraint mission_events_runner_check;

-- The channel a Mission is on call in: one channel a Mission and one Mission
-- a channel. `listen` is 'mentions' in v1 (mentions, and replies in threads
-- the Mission took); 'all' is for later. Bots' messages are never taken
-- unless `allow_bot_messages`, and the bot's own never. Paused, it says so
-- and takes nothing.
create table if not exists mission_channels (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{2,32}$'),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,32}$'),
  bound_by uuid references auth.users (id) on delete set null,
  listen text not null default 'mentions' check (listen in ('mentions', 'all')),
  allow_bot_messages boolean not null default false,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mission_channels_channel_unique unique (slack_team_id, channel_id)
);

create index if not exists mission_channels_org_idx on mission_channels (org_id);

drop trigger if exists mission_channels_set_updated_at on mission_channels;
create trigger mission_channels_set_updated_at
  before update on mission_channels
  for each row execute function set_updated_at();

-- A Slack thread the Mission took a request in: later replies there reach it
-- with no mention, unless muted (!mute). A thread is one Mission's: a
-- channel bound to another Mission later hands it over on the next mention.
create table if not exists mission_threads (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[A-Z0-9]{2,32}$'),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,32}$'),
  thread_ts text not null check (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  permalink text check (char_length(permalink) <= 500),
  -- Whoever started it: their linked Outrunner account and Slack user.
  started_by uuid references auth.users (id) on delete set null,
  started_by_slack text check (char_length(started_by_slack) <= 32),
  -- The newest request in it: what slack_react marks.
  last_request_ts text check (last_request_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  muted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mission_threads_thread_unique unique (slack_team_id, channel_id, thread_ts)
);

create index if not exists mission_threads_mission_idx on mission_threads (mission_id, updated_at desc);

drop trigger if exists mission_threads_set_updated_at on mission_threads;
create trigger mission_threads_set_updated_at
  before update on mission_threads
  for each row execute function set_updated_at();

-- Each Ship a bound Mission started, and for whom: the thread it's for, the
-- person who asked. Kept as the ledger its limits count, so a row stays when
-- its Ship is deleted. A row with no Ship yet is a place reserved for one
-- starting (reserve_mission_slack_ship); a start that fails gives it back.
create table if not exists mission_slack_ships (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  thread_id uuid references mission_threads (id) on delete set null,
  runner_id uuid unique references workspaces (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_slack text check (char_length(requested_by_slack) <= 32),
  created_at timestamptz not null default now()
);

create index if not exists mission_slack_ships_mission_idx on mission_slack_ships (mission_id, created_at desc);
create index if not exists mission_slack_ships_thread_idx on mission_slack_ships (thread_id) where thread_id is not null;

-- A Mission's own limits on Ships started while it's on call, as
-- automations have theirs (20261102198000_automation_limits.sql). No row is
-- the defaults: 6 an hour, 30 a day.
create table if not exists mission_limits (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  slack_ships_per_hour integer not null default 6 check (slack_ships_per_hour between 0 and 100),
  slack_ships_per_day integer not null default 30 check (slack_ships_per_day between 0 and 1000),
  updated_at timestamptz not null default now()
);

drop trigger if exists mission_limits_set_updated_at on mission_limits;
create trigger mission_limits_set_updated_at
  before update on mission_limits
  for each row execute function set_updated_at();

-- A question the Mission asked in a thread with buttons (slack_ask). The
-- first answer wins: it's claimed here, then reaches the Mission once.
create table if not exists mission_slack_asks (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  thread_id uuid not null references mission_threads (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 2900),
  options text[] not null check (cardinality(options) between 1 and 5),
  message_ts text,
  answer text check (char_length(answer) <= 2000),
  answered_by uuid references auth.users (id) on delete set null,
  answered_by_slack text check (char_length(answered_by_slack) <= 32),
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mission_slack_asks_mission_idx on mission_slack_asks (mission_id, created_at desc);

-- Take a place for a Ship of a bound Mission, under its limits: a row
-- reserved, or why not ('hour' or 'day'). One Mission's reservations are
-- counted one at a time, so two spawns at once can't both take the last
-- place. Every row counts, its Ship started, failed or deleted alike; a
-- start that never made a Ship gives its place back
-- (release_mission_slack_ship).
create or replace function reserve_mission_slack_ship(target uuid, thread uuid, requester uuid, slack_user text)
  returns table (ship_id uuid, refusal text)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  per_hour integer := 6;
  per_day integer := 30;
  made uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('mission_slack_ships:' || target::text, 0));
  select l.slack_ships_per_hour, l.slack_ships_per_day into per_hour, per_day
    from mission_limits l where l.mission_id = target;
  if not found then
    per_hour := 6;
    per_day := 30;
  end if;
  if (select count(*) from mission_slack_ships s where s.mission_id = target and s.created_at > now() - interval '1 hour') >= per_hour then
    ship_id := null;
    refusal := 'hour';
    return next;
    return;
  end if;
  if (select count(*) from mission_slack_ships s where s.mission_id = target and s.created_at > now() - interval '1 day') >= per_day then
    ship_id := null;
    refusal := 'day';
    return next;
    return;
  end if;
  insert into mission_slack_ships (mission_id, thread_id, requested_by, requested_by_slack)
    values (target, thread, requester, slack_user)
    returning id into made;
  ship_id := made;
  refusal := null;
  return next;
end;
$$;

-- A reserved place whose Ship never started, given back.
create or replace function release_mission_slack_ship(target uuid)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  delete from mission_slack_ships where id = target and runner_id is null;
$$;

alter table mission_channels enable row level security;
alter table mission_threads enable row level security;
alter table mission_slack_ships enable row level security;
alter table mission_limits enable row level security;
alter table mission_slack_asks enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_channels from anon, authenticated;
revoke all on table mission_threads from anon, authenticated;
revoke all on table mission_slack_ships from anon, authenticated;
revoke all on table mission_limits from anon, authenticated;
revoke all on table mission_slack_asks from anon, authenticated;
revoke all on function reserve_mission_slack_ship(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function release_mission_slack_ship(uuid) from public, anon, authenticated;
