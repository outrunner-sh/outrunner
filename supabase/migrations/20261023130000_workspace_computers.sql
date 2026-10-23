-- One Runtime Computer per workspace.
--
-- A project's sessions shared one box (20260804110000_runtime_computers.sql):
-- cheap, but their dev servers, Docker and test runs collided, and one
-- session kept the whole box awake and billed. From here a new session gets a
-- box of its own, claimed by its workspace: it sleeps and wakes on its own,
-- and goes when the session does.
--
-- A project's shared box from before stays as it was, for the sessions on it:
-- its row keeps workspace_id null, and claim_runtime_computer (by project)
-- still serves only those rows. Nothing about a running session changes.
-- ---------------------------------------------------------------------------

alter table runtime_computers
  add column if not exists workspace_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'runtime_computers_owner_workspace_fkey'
  ) then
    -- The workspace's row is marked destroyed rather than deleted, so this
    -- cascade is only for an account or project going: the box is deleted by
    -- the app when its session ends (lifecycle destroy).
    alter table runtime_computers
      add constraint runtime_computers_owner_workspace_fkey
        foreign key (owner_id, workspace_id)
        references workspaces (owner_id, id) on delete cascade;
  end if;
end $$;

-- One box per workspace; one shared box per project, as before, among the
-- rows from before (workspace_id null).
alter table runtime_computers drop constraint if exists runtime_computers_project_unique;
create unique index if not exists runtime_computers_workspace_unique
  on runtime_computers (workspace_id) where workspace_id is not null;
create unique index if not exists runtime_computers_shared_project_unique
  on runtime_computers (project_id) where workspace_id is null;

-- The project's shared box, now only among the shared ones: a project's
-- workspaces' own boxes are not it. Otherwise as 20261019140000.
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
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  perform 1
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
    and workspace_id is null;

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

-- Claim the box of one workspace: the same election as the project's, so
-- two requests for one session (its setup and a reconnect, say) start one
-- box, and the plan's box cap is enforced in the same transaction. The lock
-- is the workspace's, so sessions of one project no longer wait on each other.
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
    and owner_id = auth.uid();

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

revoke all on function claim_workspace_computer(uuid, text, text, integer) from public, anon;
grant execute on function claim_workspace_computer(uuid, text, text, integer) to authenticated;
