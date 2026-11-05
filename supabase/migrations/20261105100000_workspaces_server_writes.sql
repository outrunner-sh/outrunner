-- SECURITY — why the owner can no longer write workspaces and runtime_computers.
--
-- workspaces_owner_all and runtime_computers_owner_all were `for all`: any
-- signed-in owner could UPDATE their own rows straight through Supabase's
-- REST API, every column, including daytona_sandbox_id, agent_base_url and
-- agent_secret. Repointing a workspace's daytona_sandbox_id at another
-- user's sandbox id hands over that box's desktop WebSocket and its port
-- previews (app/api/workspaces/[id]/desktop, .../ports/[port]): the routes
-- check the workspace's owner, and the workspace is the attacker's own —
-- only its recorded box id was swapped.
--
-- As 20260928120000_user_credentials.sql (whose comment says it plainly:
-- owner-scoped is not server-only): the owner keeps a SELECT policy, and
-- insert/update/delete get no policy at all and are revoked from anon and
-- authenticated, so only the service role, which bypasses RLS, can write.
-- The server's own writes now go through the service-role client
-- (lib/db/repositories.ts and friends), whose callers have checked the
-- session's owner. RLS stays the guard on reads.
--
-- The box claims stay callable by the signed-in user — a claim counts the
-- caller's own boxes toward their plan, and auth.uid() is the caller, which
-- the service role cannot stand in for (lib/supabase/acting-user.ts). But a
-- SECURITY INVOKER claim writes with the caller's grants, which these
-- revokes take away, so the five claims become SECURITY DEFINER: their own
-- explicit checks — every one scopes by owner_id = auth.uid(), which
-- complete_pooled_warmup lacked and gains here, having leaned on RLS — are
-- the whole of the authorization now. Do NOT loosen those checks.
-- ---------------------------------------------------------------------------

drop policy if exists workspaces_owner_all on workspaces;
create policy workspaces_owner_read on workspaces
  for select using (auth.uid() = owner_id and org_id in (select my_org_ids()));

drop policy if exists runtime_computers_owner_all on runtime_computers;
create policy runtime_computers_owner_read on runtime_computers
  for select using (auth.uid() = owner_id and org_id in (select my_org_ids()));

revoke insert, update, delete on table workspaces from anon, authenticated;
revoke insert, update, delete on table runtime_computers from anon, authenticated;

-- The claims, as security definer, otherwise exactly as
-- 20261031150000_org_billing.sql: the org's box cap, and the claim that
-- answers once (20261030110000).
create or replace function claim_workspace_computer(
  requested_workspace_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1',
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  for_project uuid;
  for_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select project_id, org_id into for_project, for_org
  from workspaces
  where id = requested_workspace_id
    and owner_id = auth.uid()
    and status not in ('destroying', 'destroyed');

  if not found then
    raise exception 'workspace not found';
  end if;

  perform pg_advisory_xact_lock(hashtext('workspace_computer:' || requested_workspace_id::text));

  select * into existing
  from runtime_computers
  where workspace_id = requested_workspace_id;

  if found then
    if existing.status in ('error', 'stopped') then
      perform check_org_box_cap(for_org, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
      return;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_org_box_cap(for_org, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    workspace_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    for_project,
    requested_workspace_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;

create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1',
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  for_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select org_id into for_org
  from projects
  where id = requested_project_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'project not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_project_id::text));

  select * into existing
  from runtime_computers
  where project_id = requested_project_id
    and workspace_id is null
    and not pooled;

  if found then
    if existing.status in ('error', 'stopped') then
      perform check_org_box_cap(for_org, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
      return;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_org_box_cap(for_org, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    requested_project_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;

revoke all on function claim_workspace_computer(uuid, text, text, integer) from public, anon;
revoke all on function claim_runtime_computer(uuid, text, text, integer) from public, anon;
grant execute on function claim_workspace_computer(uuid, text, text, integer) to authenticated;
grant execute on function claim_runtime_computer(uuid, text, text, integer) to authenticated;

-- The pooled claims, as security definer, otherwise exactly as
-- 20261103210000_intent_warm_cleanup_handoff.sql.
create or replace function claim_pooled_computer(
  requested_workspace_id uuid,
  requested_provider text,
  requested_generation integer default null
)
returns text
language plpgsql
security definer
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
security definer
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

-- As 20261103210000, with the one check RLS used to supply: only the box's
-- owner may publish its wake, which as a definer this no longer leans on RLS
-- to enforce.
create or replace function complete_pooled_warmup(
  requested_computer_id uuid,
  requested_sandbox_id text,
  requested_provider text,
  requested_agent_base_url text,
  requested_timings jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  warm_row runtime_computers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into warm_row
  from runtime_computers
  where id = requested_computer_id
    and owner_id = auth.uid()
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

revoke all on function claim_pooled_computer(uuid, text, integer) from public, anon;
revoke all on function claim_pooled_warmup(uuid, text, integer, integer) from public, anon;
revoke all on function complete_pooled_warmup(uuid, text, text, text, jsonb) from public, anon;
grant execute on function claim_pooled_computer(uuid, text, integer) to authenticated;
grant execute on function claim_pooled_warmup(uuid, text, integer, integer) to authenticated;
grant execute on function complete_pooled_warmup(uuid, text, text, text, jsonb) to authenticated;
