-- Keep expiry cleanup distinct from a wake that is still publishing its agent
-- endpoint. A failed provider pause must not make that unfinished row
-- claimable by Send.

alter table runtime_computers
  add column if not exists warm_cleanup_pending boolean not null default false;

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
    and not warm_cleanup_pending
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
      warm_cleanup_pending = false,
      agent_base_url = null,
      error_message = null
  where id = pooled_row.id;

  return query select pooled_row.id, true;
end;
$$;

revoke all on function claim_pooled_warmup(uuid, text, integer, integer) from public, anon;
grant execute on function claim_pooled_warmup(uuid, text, integer, integer) to authenticated;

-- Publish a completed wake under the same row lock used to observe cleanup.
-- While a provider pause is in flight, keep the fresh endpoint durable but
-- leave the row non-claimable for its success/failure result to settle.
create or replace function complete_pooled_warmup(
  requested_computer_id uuid,
  requested_sandbox_id text,
  requested_provider text,
  requested_agent_base_url text,
  requested_timings jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  warm_row runtime_computers%rowtype;
begin
  select * into warm_row
  from runtime_computers
  where id = requested_computer_id
    and status = 'provisioning'
  for update;

  if not found then
    return false;
  end if;

  if warm_row.pooled
     and warm_row.warm_cleanup_pending
     and warm_row.warm_expires_at is null then
    update runtime_computers
    set daytona_sandbox_id = requested_sandbox_id,
        provider = requested_provider,
        agent_base_url = requested_agent_base_url,
        provision_timings = requested_timings,
        error_message = null,
        last_active_at = now()
    where id = requested_computer_id;
    return false;
  end if;

  if not warm_row.pooled or warm_row.warm_expires_at is not null then
    update runtime_computers
    set status = 'ready',
        daytona_sandbox_id = requested_sandbox_id,
        provider = requested_provider,
        agent_base_url = requested_agent_base_url,
        provision_timings = requested_timings,
        warm_cleanup_pending = false,
        error_message = null,
        last_active_at = now()
    where id = requested_computer_id;
    return true;
  end if;

  return false;
end;
$$;

revoke all on function complete_pooled_warmup(uuid, text, text, text, jsonb) from public, anon;
grant execute on function complete_pooled_warmup(uuid, text, text, text, jsonb) to authenticated;

-- A provider pause failed. Restore a retry lease, but publish ready only when
-- the concurrent wake has already made its fresh endpoint durable.
create or replace function retry_pooled_warmup_pause(
  requested_computer_id uuid,
  retry_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  endpoint_ready boolean;
begin
  select agent_base_url is not null into endpoint_ready
  from runtime_computers
  where id = requested_computer_id
    and pooled
    and status = 'provisioning'
    and warm_cleanup_pending
  for update;

  if not found then
    return false;
  end if;

  update runtime_computers
  set status = case when endpoint_ready then 'ready'::runtime_computer_status else 'provisioning'::runtime_computer_status end,
      warm_expires_at = retry_at,
      warm_cleanup_pending = not endpoint_ready,
      error_message = case when endpoint_ready then null else 'The unused pre-warm could not be paused; retrying.' end
  where id = requested_computer_id;

  return endpoint_ready;
end;
$$;

revoke all on function retry_pooled_warmup_pause(uuid, timestamptz) from public, anon, authenticated;
grant execute on function retry_pooled_warmup_pause(uuid, timestamptz) to service_role;

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
    and not warm_cleanup_pending
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
