-- The allowance on Outrunner's models, per period (lib/billing/model-allowance.ts):
-- where the cap on a user's OpenRouter key stands. OpenRouter counts a key's
-- spend over its whole life, so each period the cap becomes what's spent plus
-- the plan's allowance; these record the period it was set for and the spend
-- it started from. Beside the key, in the same service-role-only table.
-- ---------------------------------------------------------------------------

alter table user_credentials
  -- 'once' for a one-time allowance (Free); else the period's start, ISO.
  add column if not exists neev_allowance_period text,
  add column if not exists neev_allowance_plan text,
  add column if not exists neev_allowance_baseline_usd numeric,
  add column if not exists neev_allowance_limit_usd numeric;
