-- Cloud hours: how long each of Outrunner's boxes runs, for the hours a plan
-- includes (lib/billing/plans.ts), and the lease that keeps the reconciler
-- that records them (lib/billing/reconcile.ts) to one run at a time.
--
-- Only boxes Outrunner pays for are recorded: the deployment's provider, not a
-- user's own Daytona or Modal. Service-role only, like user_credentials: RLS
-- on with no policies, so no user can read another's usage or edit their own.
-- ---------------------------------------------------------------------------

create table compute_intervals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Set null, not cascade: usage outlives the computer it ran on (a project
  -- deleted mid-month still used those hours).
  computer_id uuid references runtime_computers (id) on delete set null,
  -- The provider's box id: a computer gets a new box after one is lost.
  sandbox_id text not null,
  -- vCPUs, which weigh an hour: hours count in Small-box (2 vCPU) hours.
  cpu numeric not null check (cpu > 0),
  started_at timestamptz not null default now(),
  -- The last time the box was seen running. A box that stopped without being
  -- seen to (crashed, deleted elsewhere) is counted to here, not to when that
  -- was noticed.
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint compute_intervals_seen_after_start check (last_seen_at >= started_at),
  constraint compute_intervals_ended_after_start check (ended_at is null or ended_at >= started_at)
);

-- One open interval per box: opening one twice (a provision and the
-- reconciler at once) can't count its hours twice.
create unique index compute_intervals_one_open_per_box
  on compute_intervals (sandbox_id) where ended_at is null;

-- A user's hours in a period (lib/billing/hours.ts).
create index compute_intervals_owner_started_idx
  on compute_intervals (owner_id, started_at);

alter table compute_intervals enable row level security;

-- ---------------------------------------------------------------------------
-- Leases: a named job runs on one server at a time. A lease, not an advisory
-- lock: PostgREST runs each call on whichever pooled connection is free, so a
-- session lock would not outlive the call that took it.
-- ---------------------------------------------------------------------------

create table billing_leases (
  name text primary key,
  held_until timestamptz not null
);

alter table billing_leases enable row level security;

-- Take the lease `lease_name` for `seconds`, if no one holds it now. True when
-- this call got it. Only the service role may run it.
create or replace function claim_billing_lease(lease_name text, seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
begin
  insert into billing_leases (name, held_until)
  values (lease_name, now() + make_interval(secs => seconds))
  on conflict (name) do update
    set held_until = excluded.held_until
    where billing_leases.held_until < now()
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function claim_billing_lease(text, integer) from public, anon, authenticated;
grant execute on function claim_billing_lease(text, integer) to service_role;
