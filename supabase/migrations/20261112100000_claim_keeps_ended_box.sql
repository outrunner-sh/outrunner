-- A claim on a box that ended keeps naming that box.
--
-- claim_workspace_computer and claim_runtime_computer took over a stopped or
-- failed box row by setting it provisioning AND clearing its
-- daytona_sandbox_id. The request bringing the box back then wrote the id
-- back in a second, separate statement (lib/runtime/ensure-runtime-computer.ts).
-- A request cut off between the two (a deploy rolled the control plane's
-- container in the middle of a session attach, 2026-11-12) left the row
-- provisioning and naming NO box:
--   * every later open of the session waited on a claim nobody held, then
--     failed ("Couldn't reach this session's box.");
--   * the abandoned-claim sweep (sweepAbandonedBoxClaims) could only turn it
--     into `error` with no box, so the next open made a new, empty box, and
--     the attach route said "This session has no Runtime Computer";
--   * the paused box, with the session's uncommitted files, was named by no
--     row, so the orphaned-box sweep deleted it two hours later.
--
-- Now the claim leaves daytona_sandbox_id as it is: the row goes on naming
-- the box that ended until the provision records the box that replaces it.
-- Cut off at any point, the row still names the box, the abandoned-claim
-- sweep returns it to stopped, and the next open restores it on its disk.
-- Nothing a caller passes is written to the id (the rule in
-- 20261106100000): it is only no longer cleared.
--
-- Otherwise exactly as 20261106100000_workspaces_server_writes.sql.

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

-- The box a computer last ran on (lib/billing/metering-store.ts lastMeteredBox):
-- read when a session's row lost its box, and by the orphaned-box sweep for
-- each row that may have. compute_intervals only grows.
create index if not exists compute_intervals_computer_started_idx
  on compute_intervals (computer_id, started_at desc);
