-- Review fixes to 20261028150000_org_access.sql (a migration of their own, so
-- they apply whether that one has run or not): each change to who may do
-- what is one transaction, so a failure leaves what was there.
-- ---------------------------------------------------------------------------

-- Set what Everyone (target_role null) or a role gets on all projects
-- (target_project null) or one: new_level, or nothing (null). A role or
-- project of another org fails on the foreign key, changing nothing.
create or replace function set_grant(target_org uuid, target_role uuid, target_project uuid, new_level text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new_level is null then
    delete from access_grants
    where org_id = target_org
      and role_id is not distinct from target_role
      and project_id is not distinct from target_project;
    return;
  end if;
  insert into access_grants (org_id, role_id, project_id, level)
  values (target_org, target_role, target_project, new_level)
  on conflict (
    org_id,
    coalesce(role_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) do update set level = excluded.level;
end;
$$;

-- Give a member exactly these roles. Never an admin any: they write
-- everything already. The membership row is locked, so they can't be made an
-- admin while their roles change. A role of another org fails on the foreign
-- key, and they keep the roles they had.
create or replace function set_member_roles(target_org uuid, member uuid, role_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  member_role text;
begin
  select role into member_role from organization_members
  where org_id = target_org and user_id = member
  for update;
  if not found then
    raise exception 'not_a_member';
  end if;
  if member_role = 'admin' and coalesce(array_length(role_ids, 1), 0) > 0 then
    raise exception 'admin_roles';
  end if;
  delete from member_roles where org_id = target_org and user_id = member;
  insert into member_roles (org_id, user_id, role_id)
  select distinct target_org, member, r from unnest(role_ids) as r;
end;
$$;

-- As 20261028130000, and an admin made holds no roles, in the same step.
create or replace function set_org_member_role(target_org uuid, member uuid, member_role text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from organizations where id = target_org and personal_owner_id is not null) then
    raise exception 'personal_org';
  end if;
  if member_role = 'member' and would_orphan_org(target_org, member) then
    raise exception 'last_admin';
  end if;
  update organization_members set role = member_role where org_id = target_org and user_id = member;
  if not found then
    raise exception 'not_a_member';
  end if;
  if member_role = 'admin' then
    delete from member_roles where org_id = target_org and user_id = member;
  end if;
end;
$$;

-- As 20261028150000, with each repository's level worked out once.
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
    else (
      select case
        when bool_or(s.level is null) then null
        when bool_or(s.level = 'read') then 'read'
        else 'write'
      end
      from (
        select public.project_level(member, r.project_id) as level
        from public.environment_repos r
        where r.environment_id = e.id
      ) s
    )
  end
  from public.environments e
  where e.id = target_environment
$$;

revoke all on function set_grant(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function set_member_roles(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function set_grant(uuid, uuid, uuid, text) to service_role;
grant execute on function set_member_roles(uuid, uuid, uuid[]) to service_role;
