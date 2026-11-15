-- Phase 3: a bound Mission no human has replied to for 14 days is offered a
-- pause (idle_warned_at), and paused 24 hours later if still no human
-- replies (idle_paused). Any human reply moves last_human_at and clears the
-- offer. docs/missions.md, "Idle pause".
alter table mission_channels add column if not exists last_human_at timestamptz not null default now();
alter table mission_channels add column if not exists idle_warned_at timestamptz;
alter table mission_channels add column if not exists idle_paused boolean not null default false;

-- The sweeps (lib/missions/idle-pause.ts, on the Missions tick). Each marks
-- the bindings due and queues their post in one statement, so racing ticks
-- or a retried one offer and pause each binding once: a row another tick
-- holds is skipped, and the WHERE is checked again on the row as it is now.
-- The post's key is the binding's revision and the offer's time, so it's
-- one post however often this runs.

-- Due an offer: not paused, no offer pending, no human for idle_seconds.
create or replace function offer_mission_idle_pauses(idle_seconds integer, offer_text text, max_rows integer)
  returns setof mission_channels
  language sql
  security definer
  set search_path = public
as $$
  with claimed as (
    update mission_channels c
      set idle_warned_at = now()
      where c.mission_id in (
        select q.mission_id from mission_channels q
          where not q.paused and q.idle_warned_at is null
            and q.last_human_at <= now() - make_interval(secs => idle_seconds)
          order by q.last_human_at
          limit max_rows
          for update skip locked
      )
        and not c.paused and c.idle_warned_at is null
        and c.last_human_at <= now() - make_interval(secs => idle_seconds)
      returning c.*
  ), queued as (
    insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload)
      select 'idle_offer:' || c.revision || ':' || floor(extract(epoch from c.idle_warned_at) * 1000)::bigint,
        c.mission_id, c.revision, c.slack_team_id, c.channel_id, null, 'root',
        jsonb_build_object('chunks', jsonb_build_array(offer_text))
        from claimed c
      on conflict (op_key) do nothing
  )
  select * from claimed;
$$;

-- Due the pause: offered grace_seconds ago or more, and no human since.
create or replace function pause_idle_missions(grace_seconds integer, pause_text text, max_rows integer)
  returns setof mission_channels
  language sql
  security definer
  set search_path = public
as $$
  with claimed as (
    update mission_channels c
      set paused = true, idle_paused = true
      where c.mission_id in (
        select q.mission_id from mission_channels q
          where not q.paused and q.idle_warned_at is not null
            and q.idle_warned_at <= now() - make_interval(secs => grace_seconds)
            and q.last_human_at < q.idle_warned_at
          order by q.idle_warned_at
          limit max_rows
          for update skip locked
      )
        and not c.paused and c.idle_warned_at is not null
        and c.idle_warned_at <= now() - make_interval(secs => grace_seconds)
        and c.last_human_at < c.idle_warned_at
      returning c.*
  ), queued as (
    insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload)
      select 'idle_pause:' || c.revision || ':' || floor(extract(epoch from c.idle_warned_at) * 1000)::bigint,
        c.mission_id, c.revision, c.slack_team_id, c.channel_id, null, 'root',
        jsonb_build_object('chunks', jsonb_build_array(pause_text))
        from claimed c
      on conflict (op_key) do nothing
  )
  select * from claimed;
$$;

-- The offer sweep's scan: bindings not paused, by when a human last spoke.
create index if not exists mission_channels_idle_idx on mission_channels (last_human_at) where not paused;

revoke all on function offer_mission_idle_pauses(integer, text, integer) from public, anon, authenticated;
revoke all on function pause_idle_missions(integer, text, integer) from public, anon, authenticated;
