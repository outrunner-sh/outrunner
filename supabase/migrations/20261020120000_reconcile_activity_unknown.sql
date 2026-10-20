-- B2: since when a metered box's agent hasn't given a usable answer, for the
-- reconciler (lib/billing/reconcile.ts) to pause a box whose agent has been
-- silent, unreachable or lying about the time for 15 minutes. On the
-- interval, not the computer: compute_intervals is service-role only, so no
-- user can clear it to keep their box from being paused.

alter table compute_intervals add column activity_unknown_since timestamptz;
