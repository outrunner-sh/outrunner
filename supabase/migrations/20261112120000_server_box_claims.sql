-- SECURITY — the box claims become the server's alone.
--
-- 20261106100000 left the four claims (claim_workspace_computer,
-- claim_runtime_computer, claim_pooled_computer, claim_pooled_warmup)
-- callable by `authenticated`, as SECURITY DEFINER, taking the plan's box
-- cap (max_live_computers) and the box's agent secret from their caller. A
-- signed-in user could call them over PostgREST directly with a null cap
-- (no limit on their org's boxes) and an agent secret of their choosing.
-- And check_org_box_cap returned early on a null cap before its
-- is_org_member check, so a member removed from an org could still claim a
-- box for a session or project they owned there.
--
-- Now:
--
-- - The claims are revoked from anon and authenticated and granted to
--   service_role only. The server (lib/db/repositories.ts) is their only
--   caller; it names the acting user, whom it has authenticated, in
--   `acting_user`, in place of auth.uid() (the service role has none).
-- - check_org_box_cap takes the acting user too, checks membership before
--   anything else, whatever the cap, and is the server's alone as well.
--
-- The new parameter changes every signature, and `create or replace` on a
-- changed signature adds an overload rather than replacing, so the old ones
-- are dropped first: otherwise they'd stay granted to authenticated.
-- Otherwise the bodies are 20261106100000's, auth.uid() -> acting_user, with
-- 20261112100000_claim_keeps_ended_box's change kept: taking over an ended box
-- leaves daytona_sandbox_id as it is.
-- ---------------------------------------------------------------------------

drop function if exists claim_workspace_computer(uuid, text, text, integer);
drop function if exists claim_runtime_computer(uuid, text, text, integer);
drop function if exists claim_pooled_computer(uuid, text, integer);
drop function if exists claim_pooled_warmup(uuid, text, integer, integer);
drop function if exists check_org_box_cap(uuid, integer);

create function check_org_box_cap(for_org uuid, acting_user uuid, max_live integer)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  -- Membership first, unconditionally: no cap is no reason to skip it.
  if for_org is null or acting_user is null or not exists (
    select 1 from organization_members where org_id = for_org and user_id = acting_user
  ) then
    raise exception 'org not found';
  end if;
  if max_live is null then
    return;
  end if;
  -- The org's connector: its own plan, over its own boxes.
  if exists (select 1 from org_connectors where org_id = for_org and user_id = acting_user) then
    perform pg_advisory_xact_lock(hashtext('claim_runtime_computer:' || acting_user::text));
    if live_metered_computers(acting_user) >= max_live then
      raise exception 'Automations'' % concurrent cloud sessions are already running. One ends when its run does.', max_live
        using errcode = 'P4BX1';
    end if;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('org_box_cap:' || for_org::text));
  if live_org_computers(for_org) >= max_live then
    raise exception 'Your org''s plan''s % concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.', max_live
      using errcode = 'P4BX1';
  end if;
end $$;

create function claim_workspace_computer(
  acting_user uuid,
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
  if acting_user is null then
    raise exception 'authentication required';
  end if;

  select project_id, org_id into for_project, for_org
  from workspaces
  where id = requested_workspace_id
    and owner_id = acting_user
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
      perform check_org_box_cap(for_org, acting_user, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
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

  perform check_org_box_cap(for_org, acting_user, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    workspace_id,
    agent_secret,
    image_version,
    status
  ) values (
    acting_user,
    for_project,
    requested_workspace_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;

create function claim_runtime_computer(
  acting_user uuid,
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
  if acting_user is null then
    raise exception 'authentication required';
  end if;

  select org_id into for_org
  from projects
  where id = requested_project_id
    and owner_id = acting_user;

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
      perform check_org_box_cap(for_org, acting_user, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
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

  perform check_org_box_cap(for_org, acting_user, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    agent_secret,
    image_version,
    status
  ) values (
    acting_user,
    requested_project_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;

create function claim_pooled_computer(
  acting_user uuid,
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
  for_org uuid;
  pooled_row runtime_computers%rowtype;
begin
  if acting_user is null then
    raise exception 'authentication required';
  end if;

  select project_id, org_id into for_project, for_org
  from workspaces
  where id = requested_workspace_id
    and owner_id = acting_user
    and status not in ('destroying', 'destroyed');

  if not found then
    raise exception 'workspace not found';
  end if;

  -- A removed member's session is theirs no longer to give a box.
  if not exists (select 1 from organization_members where org_id = for_org and user_id = acting_user) then
    raise exception 'org not found';
  end if;

  if exists (select 1 from runtime_computers where workspace_id = requested_workspace_id) then
    return null;
  end if;

  select * into pooled_row
  from runtime_computers
  where owner_id = acting_user
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

create function claim_pooled_warmup(
  acting_user uuid,
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
  if acting_user is null then
    raise exception 'authentication required';
  end if;

  select p.org_id into for_org
  from projects p
  where p.id = requested_project_id
    and exists (select 1 from organization_members m where m.org_id = p.org_id and m.user_id = acting_user);

  if not found then
    raise exception 'project not found';
  end if;

  select * into pooled_row
  from runtime_computers
  where owner_id = acting_user
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
  where owner_id = acting_user
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

  perform check_org_box_cap(for_org, acting_user, max_live_computers);
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

revoke all on function check_org_box_cap(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function claim_workspace_computer(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function claim_runtime_computer(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function claim_pooled_computer(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function claim_pooled_warmup(uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function check_org_box_cap(uuid, uuid, integer) to service_role;
grant execute on function claim_workspace_computer(uuid, uuid, text, text, integer) to service_role;
grant execute on function claim_runtime_computer(uuid, uuid, text, text, integer) to service_role;
grant execute on function claim_pooled_computer(uuid, uuid, text, integer) to service_role;
grant execute on function claim_pooled_warmup(uuid, uuid, text, integer, integer) to service_role;
