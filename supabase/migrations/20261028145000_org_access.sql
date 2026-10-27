-- Orgs, step five: roles and access. An org's admins decide what its members
-- may do with its projects (`projects`, one GitHub repository each, which the
-- sidebar lists and whose settings are its default `environments` row):
--
--   read  - see the project and start sessions on it
--   write - also change its settings (variables, files, scripts,
--           instructions) and hide it; on all projects, connect new ones
--
-- Grants go to Everyone in the org, or to a role; on all projects, or on one.
-- A member gets the highest level any grant that reaches them gives. Admins
-- have write on everything, always. Every org starts with Everyone: write on
-- all projects, which is what members had until now, so nothing changes
-- until an admin narrows it.
--
-- Sessions stay their owner's alone, as before; a member who loses read on a
-- project keeps their sessions on it, but can't start another.
-- ---------------------------------------------------------------------------

create table if not exists organization_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_roles_org_name_unique unique (org_id, name),
  constraint organization_roles_org_id_unique unique (org_id, id)
);

drop trigger if exists organization_roles_set_updated_at on organization_roles;
create trigger organization_roles_set_updated_at
  before update on organization_roles
  for each row execute function set_updated_at();

-- A member's roles. Gone with the membership, or the role.
create table if not exists member_roles (
  org_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  primary key (org_id, user_id, role_id),
  constraint member_roles_member_fkey
    foreign key (org_id, user_id) references organization_members (org_id, user_id) on delete cascade,
  constraint member_roles_role_fkey
    foreign key (org_id, role_id) references organization_roles (org_id, id) on delete cascade
);

create index if not exists member_roles_role_idx on member_roles (role_id);

-- A grant: to Everyone (role_id null) or a role; on all projects (project_id
-- null) or one of the org's.
create table if not exists access_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  role_id uuid,
  project_id uuid,
  level text not null check (level in ('read', 'write')),
  created_at timestamptz not null default now(),
  constraint access_grants_role_fkey
    foreign key (org_id, role_id) references organization_roles (org_id, id) on delete cascade,
  constraint access_grants_project_fkey
    foreign key (org_id, project_id) references projects (org_id, id) on delete cascade
);

-- One grant per who and what: changing one replaces it.
create unique index if not exists access_grants_one
  on access_grants (
    org_id,
    coalesce(role_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

alter table organization_roles enable row level security;
alter table member_roles enable row level security;
alter table access_grants enable row level security;
-- No policies, on purpose: the server's alone (lib/db/org-access.ts).
revoke all on table organization_roles from anon, authenticated;
revoke all on table member_roles from anon, authenticated;
revoke all on table access_grants from anon, authenticated;

-- Every org there is starts as members had it: Everyone, write, everything.
insert into access_grants (org_id, level)
select o.id, 'write' from organizations o
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- What a member may do. SECURITY DEFINER, as is_org_member: the policy on
-- projects calls project_level, and the tables it reads are the server's.
-- Each answers for the member it's given; the policy gives auth.uid().
-- ---------------------------------------------------------------------------

-- The level `member` has on the org's projects as a whole: from grants on
-- all projects. Null: none (or not a member).
create or replace function org_projects_level(member uuid, target_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when m.role = 'admin' then 'write'
    else (
      select max(g.level) from public.access_grants g
      where g.org_id = target_org
        and g.project_id is null
        and (g.role_id is null or g.role_id in (
          select r.role_id from public.member_roles r where r.org_id = target_org and r.user_id = member
        ))
    )
  end
  from public.organization_members m
  where m.org_id = target_org and m.user_id = member
$$;

-- The level `member` has on one project: from grants on all projects and on
-- it. ('write' > 'read' as text, so max() picks the higher.)
create or replace function project_level(member uuid, target_project uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when m.role = 'admin' then 'write'
    else (
      select max(g.level) from public.access_grants g
      where g.org_id = p.org_id
        and (g.project_id is null or g.project_id = p.id)
        and (g.role_id is null or g.role_id in (
          select r.role_id from public.member_roles r where r.org_id = p.org_id and r.user_id = member
        ))
    )
  end
  from public.projects p
  join public.organization_members m on m.org_id = p.org_id and m.user_id = member
  where p.id = target_project
$$;

-- The level `member` has on a project's settings (an `environments` row):
-- the lowest they have on its repositories, since changing it changes what
-- every one of them starts with; for one with none, on the org's projects.
create or replace function environment_level(member uuid, target_environment uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.environment_repos r where r.environment_id = e.id)
      then public.org_projects_level(member, e.org_id)
    when exists (
      select 1 from public.environment_repos r
      where r.environment_id = e.id and public.project_level(member, r.project_id) is null
    ) then null
    when exists (
      select 1 from public.environment_repos r
      where r.environment_id = e.id and public.project_level(member, r.project_id) = 'read'
    ) then 'read'
    else 'write'
  end
  from public.environments e
  where e.id = target_environment
$$;

-- These answer for any member: the server's alone (lib/db/org-access.ts).
revoke all on function org_projects_level(uuid, uuid) from public, anon, authenticated;
revoke all on function project_level(uuid, uuid) from public, anon, authenticated;
revoke all on function environment_level(uuid, uuid) from public, anon, authenticated;
grant execute on function org_projects_level(uuid, uuid) to service_role;
grant execute on function project_level(uuid, uuid) to service_role;
grant execute on function environment_level(uuid, uuid) to service_role;

-- The signed-in user's own, for the policies below: they answer for
-- auth.uid() alone, so anyone may call them (null signed out).
create or replace function my_project_level(target_project uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.project_level(auth.uid(), target_project)
$$;

create or replace function my_org_projects_level(target_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.org_projects_level(auth.uid(), target_org)
$$;

-- ---------------------------------------------------------------------------
-- Projects: a member sees the ones they may read; connects new ones with
-- write on all; changes (hides, re-syncs) the ones they may write.
-- ---------------------------------------------------------------------------

drop policy if exists projects_member_read on projects;
drop policy if exists projects_owner_insert on projects;
drop policy if exists projects_owner_update on projects;
drop policy if exists projects_owner_delete on projects;

create policy projects_member_read on projects
  for select using (org_id in (select my_org_ids()) and my_project_level(id) is not null);
create policy projects_writer_insert on projects
  for insert with check (
    auth.uid() = owner_id and org_id in (select my_org_ids()) and my_org_projects_level(org_id) = 'write'
  );
create policy projects_writer_update on projects
  for update using (org_id in (select my_org_ids()) and my_project_level(id) = 'write')
  with check (org_id in (select my_org_ids()) and my_project_level(id) = 'write');
create policy projects_writer_delete on projects
  for delete using (org_id in (select my_org_ids()) and my_project_level(id) = 'write');

-- ---------------------------------------------------------------------------
-- A new org starts with Everyone: write, as every org did. A trigger, so an
-- org made any way (create_team_org, a personal org on sign-up) has it.
-- ---------------------------------------------------------------------------

create or replace function organizations_default_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.access_grants (org_id, level) values (new.id, 'write');
  return new;
end;
$$;

revoke all on function organizations_default_grant() from public;

drop trigger if exists organizations_default_grant on organizations;
create trigger organizations_default_grant
  after insert on organizations
  for each row execute function organizations_default_grant();

-- ---------------------------------------------------------------------------
-- A repository's default project and its repository, made together (review
-- of 20261028140000): a teammate never finds the project without it. The
-- existing one if there is.
-- ---------------------------------------------------------------------------

create or replace function make_default_environment(target_project uuid, maker uuid, checkout text)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  project_row projects%rowtype;
  made uuid;
begin
  select * into project_row from projects where id = target_project;
  if not found then
    raise exception 'project_not_found';
  end if;
  insert into environments (org_id, owner_id, name, default_for_project_id)
  values (project_row.org_id, maker, left(project_row.name, 80), target_project)
  on conflict (default_for_project_id) where default_for_project_id is not null do nothing
  returning id into made;
  if made is null then
    select id into made from environments where default_for_project_id = target_project;
    return made;
  end if;
  insert into environment_repos (owner_id, environment_id, project_id, checkout_name)
  values (maker, made, target_project, checkout);
  return made;
end;
$$;

revoke all on function make_default_environment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function make_default_environment(uuid, uuid, text) to service_role;
