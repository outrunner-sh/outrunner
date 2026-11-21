-- One org kind, step one: a new user's org is an ordinary org, made by the
-- app when they first sign in (lib/orgs/own-org.ts), not a personal org made
-- by a trigger on auth.users. Anyone can be invited into it from the start.
-- Existing personal orgs stay as they are until they're converted.
--
-- And the cap on making orgs moves with it: one Free org per creator, their
-- own counting, where it was one team org beside a personal one. The server
-- decides whether the creator may make another (they admin an org on a paid
-- plan: lib/orgs/create.ts); this keeps two at once from both getting
-- through.
-- ---------------------------------------------------------------------------

drop trigger if exists auth_users_create_personal_org on auth.users;
drop function if exists create_personal_org();

-- The cap, now kept by create_team_org below, which knows whether the
-- creator may make another. A unique index can't.
drop index if exists organizations_one_team_org_per_creator;

-- Making orgs for one user, one at a time: the user's own and any other they
-- make take the same lock, so neither check reads before the other's insert.
create or replace function lock_org_making(creator uuid)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('org-making:' || creator::text, 0))
$$;

revoke all on function lock_org_making(uuid) from public, anon, authenticated;
grant execute on function lock_org_making(uuid) to service_role;

-- A user's own org, `org_name`, with them its admin: made only when they're
-- in no org at all, so a second sign-in, a second tab, or an invite accepted
-- first makes none. Its id, or null when none was made. It claims no domain.
create or replace function create_own_org(org_name text, creator uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  org uuid;
begin
  perform lock_org_making(creator);
  if exists (select 1 from organization_members where user_id = creator) then
    return null;
  end if;
  insert into organizations (name, created_by)
  values (org_name, creator)
  returning id into org;
  insert into organization_members (org_id, user_id, role)
  values (org, creator, 'admin');
  return org;
end;
$$;

revoke all on function create_own_org(text, uuid) from public, anon, authenticated;
grant execute on function create_own_org(text, uuid) to service_role;

-- Making another org (20261118120000_abandoned_org_domains.sql), capped: a
-- creator who already made one that's still here (a personal org doesn't
-- count) makes another only when `may_make_another` (the server's word: they
-- admin an org on a paid plan, or billing is off). Refused with
-- 'one_free_org' otherwise.
create or replace function create_team_org(org_name text, creator uuid, claimed_domain text, may_make_another boolean)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  org uuid;
begin
  perform lock_org_making(creator);
  if not may_make_another and exists (
    select 1 from organizations o where o.created_by = creator and o.personal_owner_id is null
  ) then
    raise exception 'one_free_org' using errcode = 'check_violation', hint = 'organizations_one_free_org_per_creator';
  end if;
  insert into organizations (name, created_by)
  values (org_name, creator)
  returning id into org;
  insert into organization_members (org_id, user_id, role)
  values (org, creator, 'admin');
  if claimed_domain is not null then
    delete from organization_domains d
    where d.domain = claimed_domain and org_people(d.org_id) = 0;
    insert into organization_domains (domain, org_id, claimed_by)
    values (claimed_domain, org, creator);
  end if;
  return org;
end;
$$;

revoke all on function create_team_org(text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function create_team_org(text, uuid, text, boolean) to service_role;

-- The old three-argument form, for an app from before this while it's still
-- serving: capped as the index capped it.
create or replace function create_team_org(org_name text, creator uuid, claimed_domain text)
returns uuid
language sql
security invoker
set search_path = public, pg_temp
as $$
  select create_team_org(org_name, creator, claimed_domain, false)
$$;

revoke all on function create_team_org(text, uuid, text) from public, anon, authenticated;
grant execute on function create_team_org(text, uuid, text) to service_role;
