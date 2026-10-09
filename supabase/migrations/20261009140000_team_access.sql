-- Workspaces people share (NEE-10), part two: what teammates may do.
--
-- A team's members see its projects and every session on them. Each member
-- runs their own sessions, on a Runtime Computer of their own: a box boots with
-- the Claude login of whoever provisioned it, and each member's credentials
-- stay theirs. Only a session's creator acts in it; a team's owners and admins
-- may also stop, archive or remove one. Owners and admins manage the team: its
-- name, projects and invites. Owners alone change roles and delete the team.
-- Viewers watch.
--
-- Teams, memberships and invites change only through the functions below,
-- which check the caller's role themselves.

-- --- role helpers -----------------------------------------------------------

create function manages_team(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_team_role(team, array['owner', 'admin']::team_role[])
$$;

create function can_run_sessions(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_team_role(team, array['owner', 'admin', 'member']::team_role[])
$$;

-- The team of a project, and of a session, for policies on rows that hang off
-- one. Security definer, so a policy can ask without the caller seeing the row.
create function project_team(project uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id from projects where id = project
$$;

create function workspace_team(workspace uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.team_id from workspaces w join projects p on p.id = w.project_id where w.id = workspace
$$;

-- Whether the caller and `other` are in a team together.
create function shares_team(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from team_members mine join team_members theirs on theirs.team_id = mine.team_id
    where mine.user_id = auth.uid() and theirs.user_id = other
  )
$$;

-- --- profiles ---------------------------------------------------------------

-- How a teammate is shown: their GitHub login and avatar. Written by the
-- server at sign-in; read by anyone who shares a team with them.
create table user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_login text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
  before update on user_profiles
  for each row execute function set_updated_at();

alter table user_profiles enable row level security;

create policy user_profiles_teammate_select on user_profiles
  for select using (user_id = auth.uid() or shares_team(user_id));

-- Accounts from before, where auth.users carries GitHub's metadata (Supabase
-- does; the local verifier's stand-in doesn't).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data'
  ) then
    execute $sql$
      insert into user_profiles (user_id, github_login, avatar_url)
      select id,
             coalesce(raw_user_meta_data->>'user_name', raw_user_meta_data->>'preferred_username'),
             raw_user_meta_data->>'avatar_url'
      from auth.users
      on conflict (user_id) do nothing
    $sql$;
  end if;
end $$;

-- --- projects ---------------------------------------------------------------

-- A repo once per team. It was once per owner, which a shared team breaks: two
-- admins adding one repo, or one user with a repo in two teams.
alter table projects add constraint projects_team_repo_unique unique (team_id, github_repo_id);
alter table projects drop constraint projects_owner_repo_unique;

-- owner_id now records who added a project. A team's project outlives the
-- account that added it; a personal team's projects go with its team.
alter table projects alter column owner_id drop not null;
alter table projects drop constraint projects_owner_id_fkey;
alter table projects
  add constraint projects_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete set null;

-- A project stays in its team: moving one would carry its sessions, and their
-- creators' computers, into a team they may not be in.
create function projects_keep_team()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.team_id is distinct from old.team_id then
    raise exception 'a project stays in its team' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger projects_keep_team
  before update on projects
  for each row execute function projects_keep_team();

drop policy projects_owner_all on projects;

create policy projects_member_select on projects
  for select using (is_team_member(team_id));

create policy projects_manager_insert on projects
  for insert with check (auth.uid() = owner_id and manages_team(team_id));

create policy projects_manager_update on projects
  for update using (manages_team(team_id)) with check (manages_team(team_id));

create policy projects_manager_delete on projects
  for delete using (manages_team(team_id));

-- --- sessions (workspaces) --------------------------------------------------

-- Sessions on a team's project are its members', not the project adder's.
alter table workspaces drop constraint workspaces_owner_project_fkey;
alter table workspaces
  add constraint workspaces_project_fkey
    foreign key (project_id) references projects (id) on delete cascade;

create function workspaces_keep_owner_and_project()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id or new.project_id is distinct from old.project_id then
    raise exception 'a session keeps its creator and project' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger workspaces_keep_owner_and_project
  before update on workspaces
  for each row execute function workspaces_keep_owner_and_project();

drop policy workspaces_owner_all on workspaces;

create policy workspaces_member_select on workspaces
  for select using (auth.uid() = owner_id or is_team_member(project_team(project_id)));

create policy workspaces_runner_insert on workspaces
  for insert with check (auth.uid() = owner_id and can_run_sessions(project_team(project_id)));

create policy workspaces_owner_or_manager_update on workspaces
  for update
  using (auth.uid() = owner_id or manages_team(project_team(project_id)))
  with check (auth.uid() = owner_id or manages_team(project_team(project_id)));

create policy workspaces_owner_or_manager_delete on workspaces
  for delete using (auth.uid() = owner_id or manages_team(project_team(project_id)));

-- Teammates follow a session's jobs and pull request; its creator writes them.
create policy jobs_member_select on jobs
  for select using (is_team_member(workspace_team(workspace_id)));

create policy pull_requests_member_select on pull_requests
  for select using (is_team_member(workspace_team(workspace_id)));

-- Removing a teammate's session drops its snapshot index too.
create policy workspace_snapshots_manager_delete on workspace_snapshots
  for delete using (manages_team(workspace_team(workspace_id)));

-- --- runtime computers ------------------------------------------------------

-- One per project and member: each boots with its member's Claude login.
-- Still readable by its owner only, since it holds the agent's secret.
alter table runtime_computers drop constraint runtime_computers_owner_project_fkey;
alter table runtime_computers
  add constraint runtime_computers_project_fkey
    foreign key (project_id) references projects (id) on delete cascade;
alter table runtime_computers drop constraint runtime_computers_project_unique;
alter table runtime_computers
  add constraint runtime_computers_project_owner_unique unique (project_id, owner_id);

create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1'
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

  if not can_run_sessions(project_team(requested_project_id)) then
    raise exception 'project not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_project_id::text || auth.uid()::text));

  select * into existing
  from runtime_computers
  where project_id = requested_project_id and owner_id = auth.uid();

  if found then
    runtime_computer_id := existing.id;

    if existing.status in ('error', 'stopped') then
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;

      should_provision := true;
    else
      should_provision := false;
    end if;

    return next;
    return;
  end if;

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
  ) returning id into runtime_computer_id;

  should_provision := true;
  return next;
  return;
end;
$$;

-- --- invites ----------------------------------------------------------------

-- A link an owner or admin hands out: whoever opens it, signed in, joins with
-- its role. Used once, for 7 days unless revoked. Only the token's hash is kept.
create table team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  role team_role not null check (role <> 'owner'),
  token_hash bytea not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz
);

create index team_invites_team_idx on team_invites (team_id, created_at desc);

alter table team_invites enable row level security;

create policy team_invites_manager_select on team_invites
  for select using (manages_team(team_id));

-- --- team management --------------------------------------------------------
--
-- Errors: insufficient_privilege (42501) for a caller whose role doesn't allow
-- it; check_violation (23514) for a rule it would break; no_data_found (P0002)
-- for an invite that can't be used.

create function create_team(team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  team uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  insert into teams (name, created_by) values (trim(team_name), auth.uid()) returning id into team;
  insert into team_members (team_id, user_id, role) values (team, auth.uid(), 'owner');
  return team;
end;
$$;

create function rename_team(team uuid, team_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not manages_team(team) then
    raise exception 'only a workspace''s owners and admins rename it' using errcode = '42501';
  end if;
  update teams set name = trim(team_name) where id = team;
end;
$$;

create function create_team_invite(team uuid, invite_role team_role, token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite uuid;
begin
  if not manages_team(team) then
    raise exception 'only a workspace''s owners and admins invite' using errcode = '42501';
  end if;
  if exists (select 1 from teams where id = team and personal) then
    raise exception 'a personal workspace has no one else in it' using errcode = 'check_violation';
  end if;
  if invite_role = 'owner' then
    raise exception 'make someone an owner once they have joined' using errcode = 'check_violation';
  end if;
  if invite_role = 'admin' and not has_team_role(team, array['owner']::team_role[]) then
    raise exception 'only owners invite admins' using errcode = '42501';
  end if;
  if char_length(token) < 32 then
    raise exception 'an invite token is at least 32 characters' using errcode = 'check_violation';
  end if;
  insert into team_invites (team_id, role, token_hash, created_by, expires_at)
  values (team, invite_role, sha256(convert_to(token, 'UTF8')), auth.uid(), now() + interval '7 days')
  returning id into invite;
  return invite;
end;
$$;

create function revoke_team_invite(invite uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  team uuid;
begin
  select team_id into team from team_invites where id = invite;
  if team is null or not manages_team(team) then
    raise exception 'only a workspace''s owners and admins revoke its invites' using errcode = '42501';
  end if;
  update team_invites set revoked_at = now() where id = invite and revoked_at is null;
end;
$$;

-- What an invite is for, so the page can say before joining. Null for a token
-- that can't be used.
create function team_invite_preview(token text)
returns table (team_name text, invite_role team_role)
language sql
stable
security definer
set search_path = public
as $$
  select t.name, i.role
  from team_invites i join teams t on t.id = i.team_id
  where i.token_hash = sha256(convert_to(token, 'UTF8'))
    and i.revoked_at is null and i.accepted_at is null and i.expires_at > now()
$$;

create function accept_team_invite(token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite team_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into invite from team_invites
  where token_hash = sha256(convert_to(token, 'UTF8'))
  for update;
  if not found or invite.revoked_at is not null or invite.accepted_at is not null
     or invite.expires_at <= now() then
    raise exception 'this invite has expired, been used or been revoked' using errcode = 'P0002';
  end if;
  -- Already in the team: nothing to join, and the invite stays for whoever it
  -- was meant for.
  if exists (select 1 from team_members where team_id = invite.team_id and user_id = auth.uid()) then
    return invite.team_id;
  end if;
  insert into team_members (team_id, user_id, role) values (invite.team_id, auth.uid(), invite.role);
  update team_invites set accepted_by = auth.uid(), accepted_at = now() where id = invite.id;
  return invite.team_id;
end;
$$;

-- How many owners a team would have left without `member`.
create function other_owners(team uuid, member uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from team_members
  where team_id = team and role = 'owner' and user_id <> member
$$;

create function set_team_member_role(team uuid, member uuid, new_role team_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_role team_role;
begin
  if not has_team_role(team, array['owner']::team_role[]) then
    raise exception 'only a workspace''s owners change roles' using errcode = '42501';
  end if;
  select role into member_role from team_members where team_id = team and user_id = member;
  if member_role is null then
    raise exception 'not a member of this workspace' using errcode = 'P0002';
  end if;
  if member_role = 'owner' and new_role <> 'owner' and other_owners(team, member) = 0 then
    raise exception 'a workspace keeps at least one owner' using errcode = 'check_violation';
  end if;
  update team_members set role = new_role where team_id = team and user_id = member;
end;
$$;

-- Remove someone, or leave (member = the caller). Owners remove anyone; admins
-- remove members and viewers; a team always keeps an owner.
create function remove_team_member(team uuid, member uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  their_role team_role;
begin
  select role into their_role from team_members where team_id = team and user_id = member;
  if their_role is null then
    raise exception 'not a member of this workspace' using errcode = 'P0002';
  end if;
  if exists (select 1 from teams where id = team and personal) then
    raise exception 'a personal workspace keeps its own user' using errcode = 'check_violation';
  end if;
  if member <> auth.uid() and not (
    has_team_role(team, array['owner']::team_role[])
    or (has_team_role(team, array['admin']::team_role[]) and their_role in ('member', 'viewer'))
  ) then
    raise exception 'your role can''t remove this member' using errcode = '42501';
  end if;
  if their_role = 'owner' and other_owners(team, member) = 0 then
    raise exception 'a workspace keeps at least one owner' using errcode = 'check_violation';
  end if;
  delete from team_members where team_id = team and user_id = member;
end;
$$;

-- Owners only, and never a personal team. The server destroys the team's
-- computers first: their rows go with the team, the boxes would not.
create function delete_team(team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_team_role(team, array['owner']::team_role[]) then
    raise exception 'only a workspace''s owners delete it' using errcode = '42501';
  end if;
  if exists (select 1 from teams where id = team and personal) then
    raise exception 'a personal workspace goes only with its account' using errcode = 'check_violation';
  end if;
  delete from teams where id = team;
end;
$$;

-- --- grants -----------------------------------------------------------------

-- Supabase projects made since 2025 grant the API roles nothing on new tables
-- and functions by default (older ones grant everything). Say what the app
-- needs, so these work on either: signed-in users read (RLS decides which
-- rows; every write is a function above), the server's service role does
-- everything, and policies call the role helpers as the signed-in user.
grant select on teams, team_members, team_invites, user_profiles to authenticated;
grant select, insert, update, delete on teams, team_members, team_invites, user_profiles to service_role;
grant execute on function
  has_team_role(uuid, team_role[]),
  is_team_member(uuid),
  manages_team(uuid),
  can_run_sessions(uuid),
  project_team(uuid),
  workspace_team(uuid),
  shares_team(uuid),
  create_team(text),
  rename_team(uuid, text),
  create_team_invite(uuid, team_role, text),
  revoke_team_invite(uuid),
  team_invite_preview(text),
  accept_team_invite(text),
  set_team_member_role(uuid, uuid, team_role),
  remove_team_member(uuid, uuid),
  delete_team(uuid)
to authenticated, service_role;
