-- Phase 3: daily and weekly dollar budgets per Mission (docs/missions.md,
-- "Budgets"). Spend comes from mission spend accounting
-- (20261114150000_mission_spend.sql, docs/mission-spend.md); compute is priced
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
