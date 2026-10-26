-- A warm pool: one box per project made ready ahead of its next session and
-- stopped (Daytona keeps its disk; a stopped box costs storage, not compute).
-- A new session takes it instead of making a box: the box starts again in
-- about a second, its tools, agent and repository already there, so the
-- session opens in about 4 seconds rather than 19, and a large repository is
-- fetched, not cloned. lib/runtime/warm-pool.ts makes one again after a
-- session takes it.
--
-- A pooled box's row has no workspace (workspace_id null, as a project's
-- shared box from before has), and `pooled` set until a session claims it.
-- ---------------------------------------------------------------------------

alter table runtime_computers
  add column if not exists pooled boolean not null default false;

-- One shared box per project among the rows from before, pooled ones apart;
-- and one pooled box per project.
drop index if exists runtime_computers_shared_project_unique;
create unique index if not exists runtime_computers_shared_project_unique
  on runtime_computers (project_id) where workspace_id is null and not pooled;
create unique index if not exists runtime_computers_pool_project_unique
  on runtime_computers (project_id) where pooled;

-- A pooled box isn't running for anyone: stopped once made, and the plan's
-- box cap counts boxes running sessions. Otherwise as 20261019140000.
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
    and not pooled
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;

-- The project's shared box from before, never its pooled one. Otherwise as
-- 20261023130000.
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
    and workspace_id is null
    and not pooled;

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

-- Hand the project's pooled box, made by `requested_provider`, to a session
-- that has no box yet: it becomes the session's own, still stopped, for its
-- setup to start again (the claim that follows provisions it, from its box).
-- The box's id, or null when there's none ready to take. Two sessions asking
-- at once can't both take it: the row is locked, and the second skips it.
create or replace function claim_pooled_computer(
  requested_workspace_id uuid,
  requested_provider text
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

  -- A session that has a box already (its setup started again) keeps it.
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

revoke all on function claim_pooled_computer(uuid, text) from public, anon;
grant execute on function claim_pooled_computer(uuid, text) to authenticated;
