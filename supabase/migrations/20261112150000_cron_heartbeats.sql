-- The cron's dead-man's switch (lib/cron/heartbeat.ts): each tick route
-- (app/api/*/tick, app/api/billing/reconcile) records here when its work
-- ends, and /api/health (behind BILLING_CRON_SECRET) says which job hasn't
-- succeeded lately. One row per job.
--
-- Server's alone: written and read with the service role. Additive.
-- ---------------------------------------------------------------------------

create table if not exists cron_heartbeats (
  job text primary key check (char_length(job) between 1 and 64),
  -- When the job last ran to the end, either way.
  last_run_at timestamptz,
  -- When it last ran to the end with nothing failed.
  last_success_at timestamptz,
  -- What failed last, and when: kept after a success, so a flapping job shows.
  last_error text check (char_length(last_error) <= 4000),
  last_error_at timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists cron_heartbeats_set_updated_at on cron_heartbeats;
create trigger cron_heartbeats_set_updated_at
  before update on cron_heartbeats
  for each row execute function set_updated_at();

alter table cron_heartbeats enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table cron_heartbeats from anon, authenticated;
