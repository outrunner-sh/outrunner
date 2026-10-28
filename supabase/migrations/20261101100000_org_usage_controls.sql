-- Orgs, step twelve: an org's admins' controls over its cloud usage
-- (Settings → Org → Usage). A plan's cloud hours are a hard cap already;
-- these act within it:
--
-- - usage_limit_percent: the share of the plan's hours the org may use (10 to
--   100; none: all of them). At it, no box starts, and running ones pause.
-- - alert_thresholds: the shares of the plan's hours at which its admins are
--   emailed, once each per period (org_usage_alerts).
--
-- A team org's, like its other settings (20261030150000_org_defaults.sql).
-- ---------------------------------------------------------------------------

alter table organization_settings
  add column if not exists usage_limit_percent integer check (usage_limit_percent between 10 and 100);
alter table organization_settings
  add column if not exists alert_thresholds integer[] not null default '{80,100}'
    check (alert_thresholds <@ array[50, 80, 100]);

-- Each alert sent, once per org, period and threshold: the reconciler's
-- insert decides who sends it.
create table if not exists org_usage_alerts (
  org_id uuid not null references organizations (id) on delete cascade,
  period_start timestamptz not null,
  threshold integer not null,
  sent_at timestamptz not null default now(),
  primary key (org_id, period_start, threshold)
);

alter table org_usage_alerts enable row level security;
revoke all on table org_usage_alerts from anon, authenticated;
