-- Connecting a repository failed for everyone since 20261028145000_org_access:
-- projects' policies asked my_project_level(id), which reads the project's
-- org from the projects table. A row being inserted isn't there yet for it,
-- so the level came back null, and an insert that returns its row (as
-- PostgREST's upsert does) was refused by the read policy.
--
-- The level is now worked out from the row's own org and id, the same as
-- project_level: an admin writes; anyone else has the most their grants
-- give, on all the org's projects or on this one.

create or replace function project_level_in(member uuid, target_org uuid, target_project uuid)
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
        and (g.project_id is null or g.project_id = target_project)
        and (g.role_id is null or g.role_id in (
          select r.role_id from public.member_roles r where r.org_id = target_org and r.user_id = member
        ))
    )
  end
  from public.organization_members m
  where m.org_id = target_org and m.user_id = member
$$;

create or replace function my_project_level_in(target_org uuid, target_project uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.project_level_in(auth.uid(), target_org, target_project)
$$;

-- Anyone's level is the server's to ask; a member asks only their own.
revoke all on function project_level_in(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function project_level_in(uuid, uuid, uuid) to service_role;

drop policy if exists projects_member_read on projects;
drop policy if exists projects_writer_update on projects;
drop policy if exists projects_writer_delete on projects;

create policy projects_member_read on projects
  for select using (org_id in (select my_org_ids()) and my_project_level_in(org_id, id) is not null);
create policy projects_writer_update on projects
  for update using (org_id in (select my_org_ids()) and my_project_level_in(org_id, id) = 'write')
  with check (org_id in (select my_org_ids()) and my_project_level_in(org_id, id) = 'write');
create policy projects_writer_delete on projects
  for delete using (org_id in (select my_org_ids()) and my_project_level_in(org_id, id) = 'write');
