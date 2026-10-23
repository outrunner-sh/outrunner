-- A box is claimed only for a session that is still going: a late request
-- for one being ended, or ended, mustn't bring a box back for it after its
-- own was deleted (lib/billing/release-box.deps.ts). Otherwise as
-- 20261023130000_workspace_computers.sql; its grants stay with the function.
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
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  for_project uuid;
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

  perform pg_advisory_xact_lock(hashtext('workspace_computer:' || requested_workspace_id::text));

  select * into existing
  from runtime_computers
  where workspace_id = requested_workspace_id;

  if found then
    if existing.status in ('error', 'stopped') then
      perform check_plan_box_cap(auth.uid(), max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_plan_box_cap(auth.uid(), max_live_computers);

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
