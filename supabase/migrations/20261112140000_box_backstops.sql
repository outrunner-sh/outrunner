-- Cost backstops for boxes that never read idle (lib/billing/reconcile.ts):
-- when the reconciler last had an answer from a box's agent, so a box whose
-- agent has gone quiet for hours (crashed, unreachable, a secret that won't
-- open) is paused rather than left running. Null: not in this run of the box
-- (measured from started_at). The reconciler reads without it on a database
-- from before this migration, with that limit off.
alter table compute_intervals add column if not exists agent_seen_at timestamptz;
