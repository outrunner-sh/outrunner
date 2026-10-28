-- Automations, step five: their runs. The Outrunner GitHub App's webhook
-- records one run per automation, repository, pull request and head commit
-- (the unique key, so a redelivered or repeated event starts nothing twice),
-- then starts its session as the automation's runner, on Outrunner's models.
-- A run keeps the session it started and how it went.
--
-- The server's alone (RLS on, no policy, grants revoked), reached through
-- lib/db/automation-runs.ts; the Automations page shows an org's to its
-- members.
-- ---------------------------------------------------------------------------

create table if not exists automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  pr_number integer not null check (pr_number > 0),
  pr_title text not null default '',
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  -- The session it started, once made; gone with it.
  workspace_id uuid references workspaces (id) on delete set null,
  -- started: its session is being set up. ready: set up, its prompt sent.
  -- failed: its session failed. refused: no session was made, `reason` says why.
  status text not null default 'started' check (status in ('started', 'ready', 'failed', 'refused')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (automation_id, project_id, pr_number, head_sha)
);

create index if not exists automation_runs_automation_idx on automation_runs (automation_id, created_at desc);
-- The reconciler's sweep of runs whose setup never finished, every two
-- minutes: only the few still starting.
create index if not exists automation_runs_started_idx on automation_runs (updated_at) where status = 'started';

alter table automation_runs enable row level security;
revoke all on table automation_runs from anon, authenticated;

-- A session that works on GitHub as the App to review (an automation run's):
-- its box's token requests are answered with the App's at the `review` level
-- (app/api/runtime/git-credential). Kept on the session itself, set when it's
-- made, so it holds however its run or automation goes (deleted, say).
alter table workspaces add column if not exists github_as text check (github_as in ('app_review'));
