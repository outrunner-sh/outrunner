-- Orgs, step one: every project and session belongs to an org, and every user
-- has a personal org. Nothing changes for anyone yet: each user is the only
-- member, and admin, of their personal org, and everything they have moves
-- into it. Team orgs, members and invites come next, on top of this.
--
-- Sessions (workspaces) stay their owner's alone, in any org: the policies
-- below add "and you are a member of its org" to "you own it", never replace
-- it. So the tables that hang off a session (jobs, pull_requests, snapshots,
-- attachments, imports) keep their owner-only policies unchanged.
--
-- Projects become the org's: one project per repository per org, which any
-- member may see. Until roles arrive, only its owner may change it.
-- ---------------------------------------------------------------------------

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  -- Set on a user's personal org, and only there: one each, gone with them.
  personal_owner_id uuid unique references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

create table if not exists organization_members (
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists organization_members_user_idx on organization_members (user_id);

-- Whether the signed-in user is a member of the org.
--
-- SECURITY DEFINER, unlike every other function here: the policies on
-- organization_members and organizations call it, and as the caller it would
-- read organization_members through that same policy and recurse. As its
-- owner it reads the one row it needs and nothing else; it answers only for
-- auth.uid(), so it tells a caller nothing about anyone else.
create or replace function is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = org and m.user_id = auth.uid()
  )
$$;

alter table organizations enable row level security;
alter table organization_members enable row level security;

-- Members see their orgs and their own memberships. Creating, renaming and
-- joining go through the server (service role), which checks who may.
create policy organizations_member_read on organizations
  for select using (is_org_member(id));
create policy organization_members_self_read on organization_members
  for select using (user_id = auth.uid());

revoke insert, update, delete on table organizations from anon, authenticated;
revoke insert, update, delete on table organization_members from anon, authenticated;
revoke all on table organizations from anon;
revoke all on table organization_members from anon;

-- ---------------------------------------------------------------------------
-- A personal org for every user: those here now, and each new one as they
-- sign up.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: it runs on auth.users' insert, as Supabase Auth, which
-- has no rights on these tables.
create or replace function create_personal_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  insert into public.organizations (name, personal_owner_id, created_by)
  values ('Personal', new.id, new.id)
  on conflict (personal_owner_id) do nothing
  returning id into org;
  if org is not null then
    insert into public.organization_members (org_id, user_id, role)
    values (org, new.id, 'admin')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function create_personal_org() from public;

drop trigger if exists auth_users_create_personal_org on auth.users;
create trigger auth_users_create_personal_org
  after insert on auth.users
  for each row execute function create_personal_org();

insert into organizations (name, personal_owner_id, created_by)
select 'Personal', u.id, u.id from auth.users u
on conflict (personal_owner_id) do nothing;

insert into organization_members (org_id, user_id, role)
select o.id, o.personal_owner_id, 'admin' from organizations o
where o.personal_owner_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- projects belong to an org.
-- ---------------------------------------------------------------------------

alter table projects add column if not exists org_id uuid references organizations (id) on delete cascade;

update projects p set org_id = o.id
from organizations o
where o.personal_owner_id = p.owner_id and p.org_id is null;

alter table projects alter column org_id set not null;

-- A project given no org goes to its owner's personal org: every caller until
-- team orgs pass the org they mean.
create or replace function projects_default_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null then
    select id into new.org_id from organizations where personal_owner_id = new.owner_id;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_default_org on projects;
create trigger projects_default_org
  before insert on projects
  for each row execute function projects_default_org();

-- One project per repository per org. The app upserts on this from now on.
-- One per user (projects_owner_repo_unique) stays until team orgs, where one
-- user may have a repository in two orgs: the app from before this runs
-- upserts on that, and keeps working until it's replaced, whichever of the
-- migration and the deploy comes first.
alter table projects add constraint projects_org_repo_unique unique (org_id, github_repo_id);
-- The target of the (org_id, project_id) keys below.
alter table projects add constraint projects_org_id_unique unique (org_id, id);

create index if not exists projects_org_pushed_idx on projects (org_id, pushed_at desc nulls last);

-- ---------------------------------------------------------------------------
-- A session, and a box, are in their project's org: taken from the project,
-- never chosen, so they can't disagree with it.
-- ---------------------------------------------------------------------------

-- And its owner must be a member of that org: what the old (owner_id,
-- project_id) key promised, that no one starts a session on a project that
-- isn't theirs to use. Checked as it's made; a member removed later keeps
-- their rows until they're cleared, and the policies stop them reaching them.
create or replace function org_from_project()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  select org_id into new.org_id from projects where id = new.project_id;
  if new.org_id is not null and not exists (
    select 1 from organization_members
    where org_id = new.org_id and user_id = new.owner_id
  ) then
    raise exception 'owner % is not a member of the project''s org', new.owner_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

alter table workspaces add column if not exists org_id uuid references organizations (id) on delete cascade;
update workspaces w set org_id = p.org_id from projects p where p.id = w.project_id and w.org_id is null;
alter table workspaces alter column org_id set not null;

drop trigger if exists workspaces_org_from_project on workspaces;
create trigger workspaces_org_from_project
  before insert or update of project_id on workspaces
  for each row execute function org_from_project();

alter table runtime_computers add column if not exists org_id uuid references organizations (id) on delete cascade;
update runtime_computers c set org_id = p.org_id from projects p where p.id = c.project_id and c.org_id is null;
alter table runtime_computers alter column org_id set not null;

drop trigger if exists runtime_computers_org_from_project on runtime_computers;
create trigger runtime_computers_org_from_project
  before insert or update of project_id on runtime_computers
  for each row execute function org_from_project();

-- A session or box points at a project in its own org, which may be another
-- member's: the key was (owner_id, project_id), one user's projects only.
alter table workspaces drop constraint if exists workspaces_owner_project_fkey;
alter table workspaces add constraint workspaces_org_project_fkey
  foreign key (org_id, project_id) references projects (org_id, id) on delete cascade;

alter table runtime_computers drop constraint if exists runtime_computers_owner_project_fkey;
alter table runtime_computers add constraint runtime_computers_org_project_fkey
  foreign key (org_id, project_id) references projects (org_id, id) on delete cascade;

create index if not exists workspaces_org_owner_idx on workspaces (org_id, owner_id);
create index if not exists runtime_computers_org_idx on runtime_computers (org_id);

-- ---------------------------------------------------------------------------
-- Policies.
-- ---------------------------------------------------------------------------

-- An org's members see its projects; their owner changes them (roles later).
drop policy if exists projects_owner_all on projects;
create policy projects_member_read on projects
  for select using (is_org_member(org_id));
create policy projects_owner_insert on projects
  for insert with check (auth.uid() = owner_id and is_org_member(org_id));
create policy projects_owner_update on projects
  for update using (auth.uid() = owner_id and is_org_member(org_id))
  with check (auth.uid() = owner_id and is_org_member(org_id));
create policy projects_owner_delete on projects
  for delete using (auth.uid() = owner_id and is_org_member(org_id));

-- A session, and its box, are their owner's alone, while they're a member.
drop policy if exists workspaces_owner_all on workspaces;
create policy workspaces_owner_all on workspaces
  for all using (auth.uid() = owner_id and is_org_member(org_id))
  with check (auth.uid() = owner_id and is_org_member(org_id));

drop policy if exists runtime_computers_owner_all on runtime_computers;
create policy runtime_computers_owner_all on runtime_computers
  for all using (auth.uid() = owner_id and is_org_member(org_id))
  with check (auth.uid() = owner_id and is_org_member(org_id));
