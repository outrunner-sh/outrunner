-- Missions and their Runners (docs/missions.md): a Mission is a long-lived
-- session given one domain, which plans and hands each piece of work to a
-- Runner, an ordinary cloud session of the Mission's own project whose
-- parent is the Mission. The Mission's agent drives its Runners through
-- tools on Outrunner's MCP endpoint (app/api/missions/mcp), with a token
-- good for that Mission alone.
-- ---------------------------------------------------------------------------

alter table workspaces add column if not exists kind text not null default 'session';
alter table workspaces drop constraint if exists workspaces_kind_check;
alter table workspaces add constraint workspaces_kind_check check (kind in ('session', 'mission'));

alter table workspaces
  add column if not exists parent_mission_id uuid references workspaces (id) on delete set null;
create index if not exists workspaces_parent_mission_idx
  on workspaces (parent_mission_id) where parent_mission_id is not null;

-- A Runner's parent is a Mission of the same owner, a Mission has no parent
-- (Runners don't spawn Runners), and a Mission holds at most 20 Runners that
-- aren't archived (MAX_RUNNERS in lib/missions/rules.ts). Checked as a Runner
-- is made, and as one comes back from archived, under a lock on its Mission's
-- row, so two spawns at once can't both take the last place.
create or replace function enforce_mission_runners() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  ended constant text[] := array['archived', 'destroying', 'destroyed', 'failed'];
  mission workspaces%rowtype;
  live integer;
begin
  if new.kind = 'mission' and new.parent_mission_id is not null then
    raise exception 'A Mission can''t be a Runner.' using errcode = '23514';
  end if;
  if new.parent_mission_id is null then
    return new;
  end if;
  -- Unchanged parent, and not coming back from an end: nothing to count.
  if tg_op = 'UPDATE'
    and new.parent_mission_id is not distinct from old.parent_mission_id
    and not (old.status::text = any (ended) and not (new.status::text = any (ended))) then
    return new;
  end if;
  select * into mission from workspaces where id = new.parent_mission_id for update;
  if not found or mission.kind <> 'mission' then
    raise exception 'A Runner''s parent must be a Mission.' using errcode = '23514';
  end if;
  if mission.owner_id <> new.owner_id then
    raise exception 'A Runner runs as its Mission''s owner.' using errcode = '23514';
  end if;
  if new.status::text = any (ended) then
    return new;
  end if;
  select count(*) into live
    from workspaces
    where parent_mission_id = new.parent_mission_id
      and id <> new.id
      and not (status::text = any (ended));
  if live >= 20 then
    raise exception 'mission_runner_cap: a Mission holds at most 20 Runners that aren''t archived.'
      using errcode = 'P0001', hint = 'Archive a finished Runner first.';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_mission_runners on workspaces;
create trigger workspaces_mission_runners
  before insert or update of parent_mission_id, status, kind on workspaces
  for each row execute function enforce_mission_runners();

-- Each Runner's brief, as the Mission wrote it: the one line the Runners pane
-- shows of its task, and what it was asked if the Mission needs reminding.
create table if not exists mission_runner_briefs (
  runner_id uuid primary key references workspaces (id) on delete cascade,
  mission_id uuid not null references workspaces (id) on delete cascade,
  brief text not null check (char_length(brief) <= 100000),
  created_at timestamptz not null default now()
);

create index if not exists mission_runner_briefs_mission_idx on mission_runner_briefs (mission_id);

-- The Mission's MCP token: the sha256 of one minted each time its box is set
-- up (lib/missions/token.ts), written into that box's MCP config. One a
-- Mission: a new one replaces the last.
create table if not exists mission_tokens (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  minted_at timestamptz not null default now()
);

-- The Mission's notes on its domain, its work and its decisions: kept here
-- so they outlive its box (archive and restore), and laid on the box as a
-- file for its agent to read and edit (lib/missions/setup.ts).
create table if not exists mission_notes (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  body text not null default '' check (char_length(body) <= 65536),
  updated_at timestamptz not null default now()
);

drop trigger if exists mission_notes_set_updated_at on mission_notes;
create trigger mission_notes_set_updated_at
  before update on mission_notes
  for each row execute function set_updated_at();

-- What happened to a Mission's Runners, for the Mission (lib/missions/outbox.ts).
--
-- Exactly once, end to end:
-- - recorded once: each event has an idempotency key (a webhook delivered
--   twice, two ticks that both see a turn end, record one row);
-- - sent in deliveries: one open delivery a Mission at a time, taken under a
--   lease (claim_mission_delivery), so two ticks never send at once and one
--   that dies mid-send is taken over when its lease runs out;
-- - each delivery sent with its id as the box's message key
--   (FeatureMessageKeys in the runtime-agent), which the box sends once, so a
--   delivery sent again after a crash between sending and recording it isn't
--   said twice. Once tried, a delivery's events are fixed: new ones wait for
--   the next, or a repeat the box skips would drop them.
-- - never given up: a failed send is tried again with backoff, the Mission
--   woken (or restored) first.
create table if not exists mission_deliveries (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create unique index if not exists mission_deliveries_one_open
  on mission_deliveries (mission_id) where delivered_at is null;

create table if not exists mission_events (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  runner_id uuid not null references workspaces (id) on delete cascade,
  kind text not null check (kind in ('finished', 'ready', 'needs_attention', 'merged', 'closed', 'archived')),
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 300),
  created_at timestamptz not null default now(),
  delivery_id uuid references mission_deliveries (id) on delete set null,
  delivered_at timestamptz
);

create index if not exists mission_events_pending_idx
  on mission_events (mission_id, created_at) where delivered_at is null;
create index if not exists mission_events_runner_idx on mission_events (runner_id, created_at desc);

-- Take the Mission's next delivery under a lease: the open one, when its
-- lease has run out and its backoff has passed; else a new one of the events
-- waiting, once they've settled (none newer than `settle_seconds`, or the
-- oldest waiting `max_wait_seconds`), so events that arrive together go as
-- one. Nothing when another holds the lease, or nothing waits.
create or replace function claim_mission_delivery(target uuid, lease_seconds integer, settle_seconds integer, max_wait_seconds integer)
  returns table (delivery_id uuid, attempt integer)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  open_delivery mission_deliveries%rowtype;
  made uuid;
  newest timestamptz;
  oldest timestamptz;
begin
  -- One claimer a Mission at a time.
  perform pg_advisory_xact_lock(hashtextextended('mission_delivery:' || target::text, 0));
  select * into open_delivery from mission_deliveries d
    where d.mission_id = target and d.delivered_at is null
    for update;
  if found then
    if (open_delivery.lease_until is not null and open_delivery.lease_until > now())
      or open_delivery.next_attempt_at > now() then
      return;
    end if;
    -- Never tried: what has arrived since rides along.
    if open_delivery.attempts = 0 then
      update mission_events e set delivery_id = open_delivery.id
        where e.mission_id = target and e.delivery_id is null and e.delivered_at is null;
    end if;
    update mission_deliveries d
      set lease_until = now() + make_interval(secs => lease_seconds), attempts = d.attempts + 1
      where d.id = open_delivery.id;
    delivery_id := open_delivery.id;
    attempt := open_delivery.attempts + 1;
    return next;
    return;
  end if;
  select max(e.created_at), min(e.created_at) into newest, oldest from mission_events e
    where e.mission_id = target and e.delivery_id is null and e.delivered_at is null;
  if newest is null
    or (newest > now() - make_interval(secs => settle_seconds) and oldest > now() - make_interval(secs => max_wait_seconds)) then
    return;
  end if;
  insert into mission_deliveries (mission_id, attempts, lease_until)
    values (target, 1, now() + make_interval(secs => lease_seconds))
    returning id into made;
  update mission_events e set delivery_id = made
    where e.mission_id = target and e.delivery_id is null and e.delivered_at is null;
  delivery_id := made;
  attempt := 1;
  return next;
end;
$$;

-- The delivery reached the Mission: it and its events are done.
create or replace function complete_mission_delivery(target uuid)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update mission_events set delivered_at = now() where delivery_id = target and delivered_at is null;
  update mission_deliveries set delivered_at = now(), lease_until = null where id = target and delivered_at is null;
$$;

-- The delivery didn't go: let go of its lease, and try again after a wait
-- that doubles with each attempt, up to ten minutes.
create or replace function fail_mission_delivery(target uuid, failure text)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update mission_deliveries
    set lease_until = null,
        last_error = left(failure, 2000),
        -- The exponent capped before anything is multiplied: a delivery
        -- tried for hours mustn't overflow into an error that stops its
        -- backoff for good.
        next_attempt_at = now() + make_interval(secs => least(600, 15 * power(2, least(greatest(attempts - 1, 0), 10))))
    where id = target and delivered_at is null;
$$;

-- Missions with events due a delivery, for the tick: oldest waiting first,
-- and none whose delivery is backing off or held by another, so those can't
-- crowd out the Missions that can be told now.
create or replace function missions_with_pending_events(max_missions integer)
  returns table (mission_id uuid)
  language sql
  security definer
  set search_path = public
as $$
  -- A Mission whose open delivery waits (backing off, or leased) can't be
  -- told anything now, its events in that delivery or newer ones alike.
  select e.mission_id
    from mission_events e
    where e.delivered_at is null
      and not exists (
        select 1 from mission_deliveries d
          where d.mission_id = e.mission_id and d.delivered_at is null
            and (d.next_attempt_at > now() or (d.lease_until is not null and d.lease_until > now()))
      )
    group by e.mission_id
    order by min(e.created_at)
    limit max_missions;
$$;

-- A message for a Runner held until its turn ends (message_runner's
-- `queue`), sent in order.
create table if not exists mission_queued_messages (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references workspaces (id) on delete cascade,
  runner_id uuid not null references workspaces (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 100000),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists mission_queued_messages_runner_idx
  on mission_queued_messages (runner_id, created_at) where sent_at is null;

alter table mission_runner_briefs enable row level security;
alter table mission_tokens enable row level security;
alter table mission_notes enable row level security;
alter table mission_deliveries enable row level security;
alter table mission_events enable row level security;
alter table mission_queued_messages enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql. The tools
-- check the Mission's token, then read and write with the service role.
revoke all on table mission_runner_briefs from anon, authenticated;
revoke all on table mission_tokens from anon, authenticated;
revoke all on table mission_notes from anon, authenticated;
revoke all on table mission_deliveries from anon, authenticated;
revoke all on table mission_events from anon, authenticated;
revoke all on function claim_mission_delivery(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function complete_mission_delivery(uuid) from public, anon, authenticated;
revoke all on function fail_mission_delivery(uuid, text) from public, anon, authenticated;
revoke all on function missions_with_pending_events(integer) from public, anon, authenticated;
revoke all on table mission_queued_messages from anon, authenticated;
