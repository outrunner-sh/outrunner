-- Missions on call in Slack, made reliable (docs/missions.md, "Reliability"):
-- on top of 20261119110100_mission_slack.sql, additive only.
--
-- - inbound: a Slack event for a Mission is saved before Slack is answered,
--   and processed under a lease, so a crash between the two loses nothing;
-- - requests: each Slack request a Mission took, so its Ships and their pull
--   requests are tracked by request, several to a thread;
-- - spawn keys: a Ship start is reserved under a stable key (with its place
--   under the limits, and the session id it will have) before the session
--   is made, so a retry finds the same Ship rather than starting another;
-- - outbound: every post the Mission (or the system for it) makes in Slack
--   goes through a stored queue, each with a stable key, retried with
--   backoff, never posted twice blindly;
-- - binding revisions: a binding made again is a new revision, and queued
--   posts are never moved to it.
-- ---------------------------------------------------------------------------

-- A binding's revision: new each time a Mission is put on call (a rebind is
-- a delete and an insert). What's queued under one never goes out under
-- another.
alter table mission_channels add column if not exists revision uuid not null default gen_random_uuid();

-- A Slack event a Mission may take, saved before Slack is answered
-- (app/api/integrations/slack/events). Its Slack event id is its key: a
-- retry of the event is the same row. Processed under a lease
-- (claim_mission_slack_inbound): right after the answer, and by the tick for
-- any never processed, or whose processor died.
create table if not exists mission_slack_inbound (
  event_id text primary key check (char_length(event_id) between 1 and 200),
  team_id text not null check (team_id ~ '^[A-Z0-9]{2,32}$'),
  channel_id text not null check (channel_id ~ '^[A-Z0-9]{2,32}$'),
  message jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists mission_slack_inbound_due_idx
  on mission_slack_inbound (next_attempt_at, created_at) where status = 'pending';

-- Take one event to process: only a pending one, its backoff passed, no one
-- else's lease on it. Its message, and which attempt this is; nothing when
-- it can't be taken.
create or replace function claim_mission_slack_inbound(target text, lease_seconds integer)
  returns table (message jsonb, attempt integer)
  language sql
  security definer
  set search_path = public
as $$
  update mission_slack_inbound i
    set lease_until = now() + make_interval(secs => lease_seconds), attempts = i.attempts + 1
    where i.event_id = target
      and i.status = 'pending'
      and i.next_attempt_at <= now()
      and (i.lease_until is null or i.lease_until <= now())
    returning i.message, i.attempts;
$$;

-- Processed: done, under the lease of `attempt` only (a processor whose
-- lease ran out and was taken over can't finish it).
create or replace function complete_mission_slack_inbound(target text, attempt integer)
  returns boolean
  language sql
  security definer
  set search_path = public
as $$
  with done as (
    update mission_slack_inbound
      set status = 'done', processed_at = now(), lease_until = null
      where event_id = target and status = 'pending' and attempts = attempt
      returning 1
  )
  select exists (select 1 from done);
$$;

-- Not processed: tried again after a wait that doubles (15 seconds up to ten
-- minutes), and given up after `max_attempts`.
create or replace function fail_mission_slack_inbound(target text, attempt integer, failure text, max_attempts integer)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update mission_slack_inbound
    set lease_until = null,
        last_error = left(failure, 2000),
        status = case when attempts >= max_attempts then 'failed' else 'pending' end,
        next_attempt_at = now() + make_interval(secs => least(600, 15 * power(2, least(greatest(attempts - 1, 0), 10))))
    where event_id = target and status = 'pending' and attempts = attempt;
$$;

-- Events due a processor, for the tick: never taken, or their lease run out,
-- older than `grace_seconds` (the processor right after the answer goes
-- first), oldest first.
create or replace function due_mission_slack_inbound(max_events integer, grace_seconds integer)
  returns table (event_id text)
  language sql
  security definer
  set search_path = public
as $$
  select i.event_id from mission_slack_inbound i
    where i.status = 'pending'
      and i.next_attempt_at <= now()
      and (i.lease_until is null or i.lease_until <= now())
      and i.created_at <= now() - make_interval(secs => grace_seconds)
    order by i.created_at
    limit max_events;
$$;

-- A Slack request a Mission took: its own key (the Slack event's), its
-- thread, who asked, and the binding it came in under. Its Ships are
-- tracked by it (mission_slack_ships.request_key), several to a thread.
create table if not exists mission_slack_requests (
  mission_id uuid not null references workspaces (id) on delete cascade,
  request_key text not null check (char_length(request_key) between 1 and 200),
  thread_id uuid references mission_threads (id) on delete set null,
  binding_revision uuid,
  message_ts text check (message_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_slack text check (char_length(requested_by_slack) <= 32),
  created_at timestamptz not null default now(),
  primary key (mission_id, request_key)
);

create index if not exists mission_slack_requests_thread_idx on mission_slack_requests (thread_id, created_at desc);

-- A Ship start's key: the request it's for and the Mission's own name for
-- the start, one Ship each. The session id it will have is chosen at the
-- reservation (`planned_runner_id`), so a start tried again makes, or
-- finds, that one session.
alter table mission_slack_ships add column if not exists request_key text check (char_length(request_key) between 1 and 200);
alter table mission_slack_ships add column if not exists spawn_key text check (spawn_key ~ '^[A-Za-z0-9._:-]{1,80}$');
alter table mission_slack_ships add column if not exists planned_runner_id uuid not null default gen_random_uuid();
alter table mission_slack_ships add column if not exists binding_revision uuid;

create unique index if not exists mission_slack_ships_spawn_key
  on mission_slack_ships (mission_id, coalesce(request_key, ''), spawn_key) where spawn_key is not null;
create index if not exists mission_slack_ships_request_idx on mission_slack_ships (mission_id, request_key) where request_key is not null;

-- Reserve a Ship start under its key: the reservation there already
-- (`existing`), whatever came of it; else a new one under the Mission's
-- limits (as reserve_mission_slack_ship, under the same lock, so the two
-- count together), or which limit said no.
create or replace function reserve_mission_slack_spawn(
  target uuid, request text, spawn text, thread uuid, requester uuid, slack_user text, revision uuid
)
  returns table (ship_id uuid, planned_runner_id uuid, runner_id uuid, existing boolean, refusal text, refused_at_limit integer)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  per_hour integer := 6;
  per_day integer := 30;
  found_row mission_slack_ships%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('mission_slack_ships:' || target::text, 0));
  select * into found_row from mission_slack_ships s
    where s.mission_id = target and coalesce(s.request_key, '') = coalesce(request, '') and s.spawn_key = spawn;
  if found then
    return query select found_row.id, found_row.planned_runner_id, found_row.runner_id, true, null::text, null::integer;
    return;
  end if;
  select l.slack_ships_per_hour, l.slack_ships_per_day into per_hour, per_day
    from mission_limits l where l.mission_id = target;
  if not found then
    per_hour := 6;
    per_day := 30;
  end if;
  if (select count(*) from mission_slack_ships s where s.mission_id = target and s.created_at > now() - interval '1 hour') >= per_hour then
    return query select null::uuid, null::uuid, null::uuid, false, 'hour'::text, per_hour;
    return;
  end if;
  if (select count(*) from mission_slack_ships s where s.mission_id = target and s.created_at > now() - interval '1 day') >= per_day then
    return query select null::uuid, null::uuid, null::uuid, false, 'day'::text, per_day;
    return;
  end if;
  insert into mission_slack_ships (mission_id, thread_id, requested_by, requested_by_slack, request_key, spawn_key, binding_revision)
    values (target, thread, requester, slack_user, request, spawn, revision)
    returning * into found_row;
  return query select found_row.id, found_row.planned_runner_id, null::uuid, false, null::text, null::integer;
end;
$$;

-- A post in Slack, queued (lib/missions/slack-outbox.ts): a Mission's reply
-- or question card, a reaction, or a card the system posts for it. Its key
-- (`op_key`) is stable, so queueing it twice is one post. It goes to the
-- channel and thread it names, under the binding revision it was queued
-- under, or not at all.
--
-- - pending: due at next_attempt_at, taken under a lease;
-- - sent: posted (`posted_ts`, a ts a chunk);
-- - ambiguous: a send whose outcome Slack didn't say, and the thread
--   couldn't settle; not posted again blindly;
-- - failed: Slack refused it for good, or it ran out of tries;
-- - dropped: no longer to be posted (off call or rebound, muted, the
--   requester's access gone).
create table if not exists mission_slack_posts (
  id uuid primary key default gen_random_uuid(),
  op_key text not null unique check (char_length(op_key) between 1 and 300),
  mission_id uuid not null references workspaces (id) on delete cascade,
  binding_revision uuid not null,
  team_id text not null check (team_id ~ '^[A-Z0-9]{2,32}$'),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,32}$'),
  thread_ts text not null check (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  kind text not null check (kind in ('reply', 'ask', 'reaction', 'card')),
  payload jsonb not null,
  -- Whose access it's rechecked against before it goes; null for none.
  requester uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'ambiguous', 'failed', 'dropped')),
  -- Chunks of a long reply posted so far, and their ts.
  progress integer not null default 0,
  posted_ts text[] not null default '{}',
  -- The last send's outcome was never said (a timeout): the next try looks
  -- in the thread for it before posting again.
  in_doubt boolean not null default false,
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists mission_slack_posts_due_idx
  on mission_slack_posts (next_attempt_at, created_at) where status = 'pending';
create index if not exists mission_slack_posts_thread_idx
  on mission_slack_posts (channel_id, thread_ts, created_at) where status = 'pending';
create index if not exists mission_slack_posts_mission_idx on mission_slack_posts (mission_id, created_at desc);

-- Take posts due now under a lease: only the oldest pending one of each
-- thread, so a thread's posts go in the order they were queued; `target`
-- names one (the send right after queueing it), or null for any (the tick).
create or replace function claim_mission_slack_posts(target uuid, max_posts integer, lease_seconds integer)
  returns setof mission_slack_posts
  language sql
  security definer
  set search_path = public
as $$
  update mission_slack_posts p
    set lease_until = now() + make_interval(secs => lease_seconds), attempts = p.attempts + 1
    where p.id in (
      select q.id from mission_slack_posts q
        where q.status = 'pending'
          and (target is null or q.id = target)
          and q.next_attempt_at <= now()
          and (q.lease_until is null or q.lease_until <= now())
          and not exists (
            select 1 from mission_slack_posts e
              where e.channel_id = q.channel_id and e.thread_ts = q.thread_ts
                and e.status = 'pending' and e.created_at < q.created_at
          )
        order by q.created_at
        limit max_posts
        for update skip locked
    )
    returning p.*;
$$;

-- A question card's key: the same slack_ask twice is one card.
alter table mission_slack_asks add column if not exists op_key text unique check (char_length(op_key) between 1 and 300);
-- The binding it was asked under (mission_channels.revision): a click on a
-- card of another binding (the Mission went off call, or was put on call
-- again) is refused. Null: asked before this column.
alter table mission_slack_asks add column if not exists binding_revision uuid;

alter table mission_slack_inbound enable row level security;
alter table mission_slack_requests enable row level security;
alter table mission_slack_posts enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_slack_inbound from anon, authenticated;
revoke all on table mission_slack_requests from anon, authenticated;
revoke all on table mission_slack_posts from anon, authenticated;
revoke all on function claim_mission_slack_inbound(text, integer) from public, anon, authenticated;
revoke all on function complete_mission_slack_inbound(text, integer) from public, anon, authenticated;
revoke all on function fail_mission_slack_inbound(text, integer, text, integer) from public, anon, authenticated;
revoke all on function due_mission_slack_inbound(integer, integer) from public, anon, authenticated;
revoke all on function reserve_mission_slack_spawn(uuid, text, text, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function claim_mission_slack_posts(uuid, integer, integer) from public, anon, authenticated;
