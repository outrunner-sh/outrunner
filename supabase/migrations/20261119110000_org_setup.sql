-- Setup runs per org (components/onboarding/onboarding-flow.tsx): its
-- coding agent, GitHub, the repositories it works on, its first environment
-- (made its default, 20261119100000_environments_model.sql), then a first
-- session. An org needs it until it has had a session or an environment
-- someone made (lib/orgs/setup.ts); this keeps that it was finished, or
-- skipped, so an org set up and emptied since isn't sent through it again.
-- Not a team-only default: a personal org is set up too, and
-- organization_settings_team_only refuses only a personal org's session
-- defaults (20261114120000_usage_limits_in_dollars.sql).
-- ---------------------------------------------------------------------------

alter table organization_settings
  add column if not exists setup_completed_at timestamptz;
