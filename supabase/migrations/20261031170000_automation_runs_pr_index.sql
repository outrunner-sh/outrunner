-- A pull request closing archives its automations' review sessions
-- (lib/db/automation-runs.ts, pullRequestSessions): its runs, by repository
-- and number, without reading every run.
create index if not exists automation_runs_pr_idx on automation_runs (project_id, pr_number);
