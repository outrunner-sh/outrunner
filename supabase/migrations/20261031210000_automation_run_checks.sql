-- A run's check on its pull request's head commit (lib/automations/checks.ts):
-- the GitHub App's check run, opened as the run starts and closed when its
-- review is posted, it fails, the pull request closes, or an hour passes.
-- Through the installation it was opened with.
alter table automation_runs add column if not exists check_run_id bigint;
alter table automation_runs add column if not exists check_installation_id bigint;
alter table automation_runs add column if not exists check_closed_at timestamptz;

-- The reconciler's sweep of checks no review closed: only the few open.
create index if not exists automation_runs_open_check_idx on automation_runs (created_at)
  where check_run_id is not null and check_closed_at is null;
