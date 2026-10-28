-- Orgs, step eleven: a team org's allowance on Outrunner's models (decision
-- 3). Its members' cloud sessions run Outrunner's models on one OpenRouter
-- key of the org's, capped at its plan's allowance, as a user's own key is
-- at theirs (user_credentials.neev_key_*, neev_allowance_*). A personal org's
-- is its owner's key, as before; an org's connector keeps its own.
--
-- Apart from the Slack agent's key (org_model_keys), which has its own cap.
-- The server's alone; keys sealed.
-- ---------------------------------------------------------------------------

create table if not exists org_model_allowance (
  org_id uuid primary key references organizations (id) on delete cascade,
  key_ciphertext text,
  key_hash text,
  key_created_at timestamptz,
  -- As user_credentials.neev_allowance_* (20261017160000_model_allowance.sql).
  allowance_period text,
  allowance_plan text,
  allowance_baseline_usd numeric,
  allowance_limit_usd numeric,
  created_at timestamptz not null default now()
);

alter table org_model_allowance enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table org_model_allowance from anon, authenticated;
