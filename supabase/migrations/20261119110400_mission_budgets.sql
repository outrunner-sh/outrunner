-- Phase 3: daily and weekly dollar budgets per Mission (docs/missions.md,
-- "Budgets"). Spend comes from mission spend accounting
-- (20261119110000_mission_spend.sql, docs/mission-spend.md); compute is priced
-- at the plan's included rate. No row: no budget.
create table if not exists mission_budgets (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  daily_usd numeric(12, 2) check (daily_usd > 0),
  weekly_usd numeric(12, 2) check (weekly_usd > 0),
  set_by uuid references auth.users (id) on delete set null,
  -- Reached: no Mission turn and no Ship start, by any way in (Slack,
  -- triggers, the app), until paused_until (the next period's start, as
  -- lib/missions/spend.ts's spendPeriod has it) or a raised limit. On the
  -- Mission, not its binding: an unbind or rebind can't clear it.
  paused_period text check (paused_period in ('day', 'week')),
  paused_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists mission_budgets_set_updated_at on mission_budgets;
create trigger mission_budgets_set_updated_at
  before update on mission_budgets
  for each row execute function set_updated_at();

alter table mission_budgets enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_budgets from anon, authenticated;

-- Set (or clear: both limits null) a Mission's budget, with the pause the
-- new limits call for, in one write: lib/missions/budget.deps.ts decides it
-- from the spend first, so a raised limit lifts the pause in the same
-- request and a lowered one pauses at once.
create or replace function set_mission_budget(
  target uuid,
  target_org uuid,
  daily numeric,
  weekly numeric,
  by_user uuid,
  pause_period text,
  pause_until timestamptz
)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if daily is null and weekly is null then
    delete from mission_budgets where mission_id = target;
    return;
  end if;
  insert into mission_budgets (mission_id, org_id, daily_usd, weekly_usd, set_by, paused_period, paused_until)
    values (target, target_org, daily, weekly, by_user, pause_period, pause_until)
    on conflict (mission_id) do update
      set daily_usd = excluded.daily_usd,
          weekly_usd = excluded.weekly_usd,
          set_by = excluded.set_by,
          paused_period = excluded.paused_period,
          paused_until = excluded.paused_until;
end;
$$;

-- Pause a Mission for its budget, or lift the pause (period null), as one of
-- the ways in decided it from the limits it read: only while the limits are
-- still those, so a check that read the old limits can't pause a Mission
-- whose limit was just raised. Whether it applied.
create or replace function settle_mission_budget_pause(
  target uuid,
  expect_daily numeric,
  expect_weekly numeric,
  pause_period text,
  pause_until timestamptz
)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  update mission_budgets b
    set paused_period = pause_period, paused_until = pause_until
    where b.mission_id = target
      and b.daily_usd is not distinct from expect_daily
      and b.weekly_usd is not distinct from expect_weekly
      and (b.paused_period is distinct from pause_period or b.paused_until is distinct from pause_until);
  if found then return true; end if;
  return exists (
    select 1 from mission_budgets b
      where b.mission_id = target
        and b.daily_usd is not distinct from expect_daily
        and b.weekly_usd is not distinct from expect_weekly
  );
end;
$$;

-- missions_with_pending_events (20261102200000_missions.sql), leaving out
-- Missions budget-paused now: their events are held, not dropped, and mustn't
-- crowd out the Missions that can be told. Once paused_until passes, they're
-- listed again, and delivery checks the budget afresh.
create or replace function missions_with_pending_events(max_missions integer)
  returns table (mission_id uuid)
  language sql
  security definer
  set search_path = public
as $$
  select e.mission_id
    from mission_events e
    where e.delivered_at is null
      and not exists (
        select 1 from mission_deliveries d
          where d.mission_id = e.mission_id and d.delivered_at is null
            and (d.next_attempt_at > now() or (d.lease_until is not null and d.lease_until > now()))
      )
      and not exists (
        select 1 from mission_budgets b
          where b.mission_id = e.mission_id and b.paused_until is not null and b.paused_until > now()
      )
    group by e.mission_id
    order by min(e.created_at)
    limit max_missions;
$$;

revoke all on function set_mission_budget(uuid, uuid, numeric, numeric, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function settle_mission_budget_pause(uuid, numeric, numeric, text, timestamptz) from public, anon, authenticated;
revoke all on function missions_with_pending_events(integer) from public, anon, authenticated;
