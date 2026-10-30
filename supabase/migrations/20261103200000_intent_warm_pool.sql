-- Wake one stopped pooled box while a user composes a new session. The short
-- lease is visible in the row, so a concurrent Send can take the same box and
-- wait for its wake-up instead of provisioning another one. An unused box is
-- paused again by the billing reconciler (lib/runtime/warm-pool.deps.ts).
-- ---------------------------------------------------------------------------

alter table runtime_computers
  add column if not exists warm_expires_at timestamptz;

create index if not exists runtime_computers_warm_expiry_idx
  on runtime_computers (warm_expires_at)
  where pooled and warm_expires_at is not null;

-- A hot pooled box consumes the same plan slot as the session that is about
-- to take it. A pool refill remains outside the count: it has no warm lease.
create or replace function live_metered_computers(for_owner uuid)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from runtime_computers
  where owner_id = for_owner
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;

create or replace function live_org_computers(for_org uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from runtime_computers
  where org_id = for_org
    and owner_id not in (select user_id from org_connectors where org_id = for_org)
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;
revoke all on function live_org_computers(uuid) from public, anon, authenticated;

-- Start or extend this member's one intent warm-up for a project. The plan
-- check and stopped -> provisioning transition share this transaction, so
-- simultaneous composers cannot warm past the org's box cap.
create or replace function claim_pooled_warmup(
  requested_project_id uuid,
  requested_provider text,
  requested_generation integer default null,
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_wake boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  pooled_row runtime_computers%rowtype;
  for_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select org_id into for_org
  from projects
  where id = requested_project_id;

  if not found then
    raise exception 'project not found';
  end if;

  -- Repeated focus/typing keeps an existing warm-up alive without starting
  -- another box. A provisioning row here is a wake-up, not a pool refill:
  -- only wake-ups carry warm_expires_at.
  select * into pooled_row
  from runtime_computers
  where owner_id = auth.uid()
    and project_id = requested_project_id
    and pooled
    and provider = requested_provider
    and daytona_sandbox_id is not null
    and warm_expires_at is not null
    and status in ('provisioning', 'ready')
    and (requested_generation is null or generation = requested_generation)
  order by pool_slot
  limit 1
  for update skip locked;

  if found then
    update runtime_computers
    set warm_expires_at = now() + interval '90 seconds'
    where id = pooled_row.id;
    return query select pooled_row.id, false;
    return;
  end if;

  select * into pooled_row
  from runtime_computers
  where owner_id = auth.uid()
    and project_id = requested_project_id
    and pooled
    and provider = requested_provider
    and status = 'stopped'
    and daytona_sandbox_id is not null
    and (requested_generation is null or generation = requested_generation)
  order by pool_slot
  limit 1
  for update skip locked;

  if not found then
    return;
  end if;

  perform check_org_box_cap(for_org, max_live_computers);
  update runtime_computers
  set status = 'provisioning',
      warm_expires_at = now() + interval '90 seconds',
      error_message = null
  where id = pooled_row.id;

  return query select pooled_row.id, true;
end;
$$;

revoke all on function claim_pooled_warmup(uuid, text, integer, integer) from public, anon;
grant execute on function claim_pooled_warmup(uuid, text, integer, integer) to authenticated;

-- A session may take a box that is already awake, or wait on one whose
-- intent wake-up is still finishing. A provisioning pool refill has no warm
-- lease and is deliberately not eligible.
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
    and daytona_sandbox_id is not null
    and provider = requested_provider
    and (
      status in ('stopped', 'ready')
      or (status = 'provisioning' and warm_expires_at is not null)
    )
    and (requested_generation is null or generation = requested_generation)
  order by
    case status when 'ready' then 0 when 'provisioning' then 1 else 2 end,
    pool_slot
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update runtime_computers
  set pooled = false,
      workspace_id = requested_workspace_id,
      warm_expires_at = null
  where id = pooled_row.id;

  return pooled_row.daytona_sandbox_id;
end;
$$;

revoke all on function claim_pooled_computer(uuid, text, integer) from public, anon;
grant execute on function claim_pooled_computer(uuid, text, integer) to authenticated;
