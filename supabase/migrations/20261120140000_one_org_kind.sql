-- One org kind, step two: every personal org becomes an ordinary org, as a
-- new user's own already is (20261120130000_own_org_on_sign_in.sql). Anyone
-- can be invited into it; its admin can set its keys, defaults and name. The
-- personal_owner_id column stays, empty, until the app no longer reads it.
--
-- 1. A personal org that holds nothing, whose owner is in another org, is
--    deleted: it would only be a second, empty org in their switcher.
-- 2. The rest keep everything they hold. One still named "Personal" is
--    renamed "<First name>'s organization", as a new user's is
--    (lib/orgs/own-org.ts ownOrgName); one its owner renamed keeps its name.
-- 3. What told a personal org apart goes: the guards refusing it keys,
--    defaults, members and joins, and the projects/environments default.
--
-- The dry run before deploying (test/one-org-kind-sql.test.ts DRY_RUN) counts
-- what 1 and 2 would do, read-only.
-- ---------------------------------------------------------------------------

-- 1. "Holds nothing": no row in any table that references the org, but its
-- owner's own membership and the access grant every org is made with
-- (20261028145000_org_access.sql). Asked of every such table there is, so a
-- table added later is never missed.
create temp table empty_personal_orgs as
select o.id
from organizations o
where o.personal_owner_id is not null
  and exists (
    select 1 from organization_members m
    where m.user_id = o.personal_owner_id and m.org_id <> o.id
  )
  and not exists (
    select 1 from organization_members m
    where m.org_id = o.id and m.user_id <> o.personal_owner_id
  );

do $$
declare
  ref record;
begin
  for ref in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f'
      and c.confrelid = 'public.organizations'::regclass
      and c.conrelid not in ('public.organization_members'::regclass, 'public.access_grants'::regclass)
  loop
    execute format('delete from empty_personal_orgs e where exists (select 1 from %s t where t.%I = e.id)', ref.tbl, ref.col);
  end loop;
end $$;

delete from organizations where id in (select id from empty_personal_orgs);
drop table empty_personal_orgs;

-- 2. The name a new user's own org gets (ownOrgName): the first word of their
-- full name, else their GitHub login, else their email's local part (to any
-- "+tag"), at most 60 characters; else "My organization".
create or replace function own_org_name(member uuid)
returns text
language sql
stable
security invoker
set search_path = public, auth, pg_temp
as $$
  select coalesce(
    left(nullif(coalesce(
      nullif(split_part(btrim(u.raw_user_meta_data ->> 'full_name'), ' ', 1), ''),
      nullif(split_part(btrim(u.raw_user_meta_data ->> 'name'), ' ', 1), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'user_name'), ''),
      split_part(split_part(u.email, '@', 1), '+', 1)
    ), ''), 60) || '''s organization',
    'My organization'
  )
  from (select member as id) wanted
  left join auth.users u on u.id = wanted.id
$$;

update organizations o
set name = own_org_name(o.personal_owner_id)
where o.personal_owner_id is not null and o.name = 'Personal';

drop function own_org_name(uuid);

update organizations set personal_owner_id = null where personal_owner_id is not null;

-- 3. Nothing refuses an org for being someone's own any more.
drop trigger if exists org_provider_keys_team_only on org_provider_keys;
drop function if exists org_provider_keys_team_only();
drop trigger if exists organization_settings_team_only on organization_settings;
drop function if exists organization_settings_team_only();

-- As 20261028155000_org_access_atomic.sql (and since) had them, less the refusal of a
-- personal org.
create or replace function remove_org_member(target_org uuid, member uuid, remover uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if would_orphan_org(target_org, member) then
    raise exception 'last_admin';
  end if;
  delete from organization_members where org_id = target_org and user_id = member;
  if not found then
    raise exception 'not_a_member';
  end if;
  insert into organization_removals (org_id, user_id, removed_by)
  values (target_org, member, remover)
  on conflict (org_id, user_id) do update set removed_by = excluded.removed_by, removed_at = now();
end;
$$;

create or replace function set_org_member_role(target_org uuid, member uuid, member_role text)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
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

-- A project or environment made without an org goes into its owner's own
-- org: the first they made and still administer (lib/db/orgs.ts ownOrgId).
create or replace function projects_default_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null then
    select o.id into new.org_id
    from organizations o
    join organization_members m on m.org_id = o.id and m.user_id = new.owner_id and m.role = 'admin'
    where o.created_by = new.owner_id
    order by o.created_at, o.id
    limit 1;
  end if;
  return new;
end;
$$;

create or replace function environments_default_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null and new.default_for_project_id is not null then
    select org_id into new.org_id from projects where id = new.default_for_project_id;
  end if;
  if new.org_id is null then
    select o.id into new.org_id
    from organizations o
    join organization_members m on m.org_id = o.id and m.user_id = new.owner_id and m.role = 'admin'
    where o.created_by = new.owner_id
    order by o.created_at, o.id
    limit 1;
  end if;
  return new;
end;
$$;
