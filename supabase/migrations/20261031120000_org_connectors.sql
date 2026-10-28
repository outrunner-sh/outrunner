-- Automations, run by the org: each team org's `outrunner-connector`, a
-- service user the server makes the first time one of the org's automations
-- runs (lib/automations/connector.ts). Automation sessions run as it rather
-- than as a member: they're in no one's list, and they're paid by the
-- deployment, on the connector's own plan and monthly allowance on
-- Outrunner's models (lib/billing/entitlements.ts), not a member's.
--
-- It's an admin of the org (write on every project, which a review's token
-- needs), kept off the Members page. The server's alone (RLS on, no policy,
-- grants revoked).
-- ---------------------------------------------------------------------------

create table if not exists org_connectors (
  org_id uuid primary key references organizations (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table org_connectors enable row level security;
revoke all on table org_connectors from anon, authenticated;
