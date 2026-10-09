-- Workspaces people share (NEE-10). In code a team, since a `workspaces` row is
-- one session. This is the foundation: who belongs to a team and with what
-- role, a personal team for every user, and every project in a team. Rows are
-- still read and written by owner_id; what a team's members may see of each
-- other's work comes later.

create type team_role as enum ('owner', 'admin', 'member', 'viewer');

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  -- A user's own: made with their account, holds what they had before teams,
  -- and never has anyone else in it.
  personal boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index teams_one_personal_per_user on teams (created_by) where personal;

create trigger teams_set_updated_at
  before update on teams
  for each row execute function set_updated_at();

create table team_members (
  team_id uuid not null references teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role team_role not null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_id_idx on team_members (user_id);

-- A personal team has its own user in it, no one else.
create function personal_team_member_check()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from teams
    where id = new.team_id and personal and created_by is distinct from new.user_id
  ) then
    raise exception 'only its own user belongs to a personal team'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger personal_team_member_check
  before insert or update on team_members
  for each row execute function personal_team_member_check();

-- Whether the signed-in user holds one of `roles` in `team`. Security definer,
-- so policies (team_members' own included) can ask without recursing into
-- team_members' RLS; it only ever answers for the caller.
create function has_team_role(team uuid, roles team_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from team_members
    where team_id = team and user_id = auth.uid() and role = any (roles)
  )
$$;

create function is_team_member(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_team_role(team, enum_range(null::team_role))
$$;

alter table teams enable row level security;
alter table team_members enable row level security;

-- Members see their teams and who else is in them. There are no write
-- policies: teams and memberships change through the server only.
create policy teams_member_select on teams
  for select using (is_team_member(id));

create policy team_members_member_select on team_members
  for select using (is_team_member(team_id));

-- Every account gets its personal team as it is created, and loses it with the
-- account (before delete: `created_by` is set null afterwards).
create function create_personal_team()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  team uuid;
begin
  insert into teams (name, personal, created_by)
  values ('Personal', true, new.id)
  returning id into team;
  insert into team_members (team_id, user_id, role) values (team, new.id, 'owner');
  return new;
end;
$$;

create trigger create_personal_team
  after insert on auth.users
  for each row execute function create_personal_team();

create function delete_personal_team()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from teams where personal and created_by = old.id;
  return old;
end;
$$;

create trigger delete_personal_team
  before delete on auth.users
  for each row execute function delete_personal_team();

-- Accounts made before teams.
with made as (
  insert into teams (name, personal, created_by)
  select 'Personal', true, u.id
  from auth.users u
  where not exists (select 1 from teams t where t.personal and t.created_by = u.id)
  returning id, created_by
)
insert into team_members (team_id, user_id, role)
select id, created_by, 'owner' from made;

-- Every project belongs to a team: today's in their owner's personal one.
alter table projects add column team_id uuid references teams (id) on delete cascade;

update projects p
set team_id = t.id
from teams t
where t.personal and t.created_by = p.owner_id;

-- Until projects can be added to a shared team, one synced without a team goes
-- to its owner's personal team.
create function default_project_team()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.team_id is null then
    select id into new.team_id from teams where personal and created_by = new.owner_id;
  end if;
  return new;
end;
$$;

create trigger default_project_team
  before insert on projects
  for each row execute function default_project_team();

alter table projects alter column team_id set not null;

create index projects_team_id_idx on projects (team_id);

-- Only a team's owners and admins add its projects, so a project can't be put
-- into someone else's team by naming it.
drop policy projects_owner_all on projects;
create policy projects_owner_all on projects
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id and has_team_role(team_id, array['owner', 'admin']::team_role[]));
