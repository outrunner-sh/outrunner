-- Review fixes to 20261027120000_organizations.sql, which is applied already.
--
-- - A session's or box's owner is checked against its org when the owner
--   changes too, not only the project: the (owner_id, project_id) key that
--   held it before is gone.
-- - A project stays in the org it was made in: no moving between orgs.
-- - A project that isn't there, or can't be seen, is named as such, not
--   reported as a missing org_id.
-- ---------------------------------------------------------------------------

create or replace function org_from_project()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  select org_id into new.org_id from projects where id = new.project_id;
  if new.org_id is null then
    raise exception 'project % not found', new.project_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from organization_members
    where org_id = new.org_id and user_id = new.owner_id
  ) then
    raise exception 'owner % is not a member of the project''s org', new.owner_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_org_from_project on workspaces;
create trigger workspaces_org_from_project
  before insert or update of project_id, owner_id, org_id on workspaces
  for each row execute function org_from_project();

drop trigger if exists runtime_computers_org_from_project on runtime_computers;
create trigger runtime_computers_org_from_project
  before insert or update of project_id, owner_id, org_id on runtime_computers
  for each row execute function org_from_project();

create or replace function projects_keep_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'a project stays in the org it was made in'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_keep_org on projects;
create trigger projects_keep_org
  before update of org_id on projects
  for each row execute function projects_keep_org();
