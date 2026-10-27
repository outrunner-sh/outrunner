-- Warm and start hooks, and two ready boxes per project.
--
-- A project (an `environments` row) gets the two scripts Replicas' environments
-- have: a warm hook, run ahead of time on a ready box of the warm pool
-- (lib/runtime/warm-pool.ts) so the work is done before a session takes it,
-- and a start hook, run each time a session's agent launches. The setup
-- script from Conductor stays as it was: once per session.
--
-- setup_generation counts the changes a ready box is made from (the warm
-- hook, the variables, the files): a box made from an older one is not taken
-- (claim_pooled_computer) and is replaced at the next refill. warm_* record
-- the last warm hook's run on a ready box, for the settings page.
--
-- The pool holds two boxes per project and member rather than one
-- (20261028120000 made it one per member): pool_slot 0 or 1, each unique
-- among a member's pooled rows of the project.
-- ---------------------------------------------------------------------------

alter table environments
  add column if not exists warm_hook text,
  add column if not exists start_hook text,
  add column if not exists setup_generation integer not null default 1,
  add column if not exists warm_status text check (warm_status in ('running', 'succeeded', 'failed')),
  add column if not exists warm_log text,
  add column if not exists warm_started_at timestamptz,
  add column if not exists warm_finished_at timestamptz,
  add column if not exists warm_generation integer;

alter table runtime_computers
  add column if not exists pool_slot smallint not null default 0 check (pool_slot between 0 and 1),
  add column if not exists generation integer;

drop index if exists runtime_computers_pool_project_unique;
drop index if exists runtime_computers_pool_project_owner_unique;
create unique index if not exists runtime_computers_pool_slot_unique
  on runtime_computers (project_id, owner_id, pool_slot) where pooled;

-- As 20261025120000, but only a box made from `requested_generation` of the
-- project's setup is taken (null: any, as before), the lowest slot first.
-- The two-argument form goes, so a call with two arguments (a deploy from
-- before this) takes this one, with any generation.
drop function if exists claim_pooled_computer(uuid, text);

create or replace function claim_pooled_computer(
  requested_workspace_id uuid,
  requested_provider text,
  requested_generation integer default null
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  for_project uuid;
  pooled_row runtime_computers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select project_id into for_project
  from workspaces
  where id = requested_workspace_id
    and owner_id = auth.uid()
    and status not in ('destroying', 'destroyed');

  if not found then
    raise exception 'workspace not found';
  end if;

  if exists (select 1 from runtime_computers where workspace_id = requested_workspace_id) then
    return null;
  end if;

  select * into pooled_row
  from runtime_computers
  where owner_id = auth.uid()
    and project_id = for_project
    and pooled
    and status = 'stopped'
    and daytona_sandbox_id is not null
    and provider = requested_provider
    and (requested_generation is null or generation = requested_generation)
  order by pool_slot
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update runtime_computers
  set pooled = false,
      workspace_id = requested_workspace_id
  where id = pooled_row.id;

  return pooled_row.daytona_sandbox_id;
end;
$$;

revoke all on function claim_pooled_computer(uuid, text, integer) from public, anon;
grant execute on function claim_pooled_computer(uuid, text, integer) to authenticated;

-- Move a project's setup on a generation, so its ready boxes are made again:
-- the new generation. Service role only, as the table is.
create or replace function bump_environment_generation(target uuid)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  update environments
  set setup_generation = setup_generation + 1
  where id = target
  returning setup_generation;
$$;

revoke all on function bump_environment_generation(uuid) from public, anon, authenticated;
