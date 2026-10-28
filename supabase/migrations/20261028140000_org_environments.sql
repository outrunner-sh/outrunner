-- Orgs, step four: a project (an `environments` row, 20261027121000) is its
-- org's, as its repositories are. A repository has one default project in
-- its org, which every member's sessions start from, rather than one per
-- person; and a session points at its project through its org, so a member's
-- session can start from a project a teammate made.
--
-- owner_id stays on both tables, as who made the row. The tables stay the
-- server's alone (lib/db/environments.ts), which checks the asker is a member
-- of the project's org.
-- ---------------------------------------------------------------------------

alter table environments add column if not exists org_id uuid references organizations (id) on delete cascade;

-- A repository's default project is in the repository's org; one a user made,
-- in its first repository's org, else its maker's personal org.
update environments e set org_id = p.org_id
from projects p
where p.id = e.default_for_project_id and e.org_id is null;

update environments e set org_id = (
  select p.org_id
  from environment_repos r join projects p on p.id = r.project_id
  where r.environment_id = e.id
  order by r.position, r.created_at
  limit 1
)
where e.org_id is null;

update environments e set org_id = o.id
from organizations o
where o.personal_owner_id = e.owner_id and e.org_id is null;

alter table environments alter column org_id set not null;

-- Given none, the org it's for: its repository's, else its maker's personal
-- org. The app names it; this keeps a row from before right.
create or replace function environments_default_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null and new.default_for_project_id is not null then
    select org_id into new.org_id from projects where id = new.default_for_project_id;
  end if;
  if new.org_id is null then
    select id into new.org_id from organizations where personal_owner_id = new.owner_id;
  end if;
  return new;
end;
$$;

drop trigger if exists environments_default_org on environments;
create trigger environments_default_org
  before insert on environments
  for each row execute function environments_default_org();

alter table environments add constraint environments_org_id_unique unique (org_id, id);

-- One default project per repository: a repository is one org's, so this is
-- one per repository per org, shared by its members. Two from before (one
-- per person) can't be: only a repository's own owner could make one.
drop index if exists environments_default_project_unique;
create unique index if not exists environments_default_project_unique
  on environments (default_for_project_id) where default_for_project_id is not null;

alter table environments drop constraint if exists environments_default_project_fkey;
alter table environments add constraint environments_default_project_fkey
  foreign key (org_id, default_for_project_id) references projects (org_id, id) on delete cascade;

create index if not exists environments_org_idx on environments (org_id);

-- ---------------------------------------------------------------------------
-- A project's repositories are in its org.
-- ---------------------------------------------------------------------------

alter table environment_repos add column if not exists org_id uuid;
update environment_repos r set org_id = e.org_id from environments e where e.id = r.environment_id and r.org_id is null;

do $$
declare n integer;
begin
  select count(*) into n
  from environment_repos r join projects p on p.id = r.project_id
  where p.org_id <> r.org_id;
  if n > 0 then
    raise exception '% project repositories are in another org than their project: move them by hand first', n;
  end if;
end $$;

alter table environment_repos alter column org_id set not null;

-- Taken from the project it's a repository of, never chosen.
create or replace function environment_repos_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  select org_id into new.org_id from environments where id = new.environment_id;
  return new;
end;
$$;

drop trigger if exists environment_repos_org on environment_repos;
create trigger environment_repos_org
  before insert or update of environment_id on environment_repos
  for each row execute function environment_repos_org();

alter table environment_repos drop constraint if exists environment_repos_environment_fkey;
alter table environment_repos add constraint environment_repos_environment_fkey
  foreign key (org_id, environment_id) references environments (org_id, id) on delete cascade;

alter table environment_repos drop constraint if exists environment_repos_project_fkey;
alter table environment_repos add constraint environment_repos_project_fkey
  foreign key (org_id, project_id) references projects (org_id, id) on delete cascade;

create index if not exists environment_repos_org_project_idx on environment_repos (org_id, project_id);

-- ---------------------------------------------------------------------------
-- A session's project is in the session's org, whoever made it.
-- ---------------------------------------------------------------------------

alter table workspaces drop constraint if exists workspaces_environment_fkey;
alter table workspaces add constraint workspaces_environment_fkey
  foreign key (org_id, environment_id) references environments (org_id, id) on delete set null (environment_id);
