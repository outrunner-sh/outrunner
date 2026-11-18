-- An org none of whose people are left holds its domain for no one. Its
-- members go when their accounts are deleted (organization_members.user_id
-- on delete cascade), so an org can end up with only its connector, or no
-- one: then nobody from its domain could make an org (one per domain) or be
-- let into it (no admin to approve). Such an org no longer counts as having
-- its domain, and the next org made for that domain takes the claim over.
-- ---------------------------------------------------------------------------

-- An org's people: its members but its connector (20261031120000_org_connectors.sql).
create or replace function org_people(target_org uuid)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*) from organization_members m
  where m.org_id = target_org
    and not exists (select 1 from org_connectors c where c.user_id = m.user_id)
$$;

revoke all on function org_people(uuid) from public, anon, authenticated;
grant execute on function org_people(uuid) to service_role;

-- The orgs that have claimed any of these domains and still have people, with
-- how many: what someone from one of them is pointed at (lib/db/orgs.ts).
create or replace function domain_orgs(domains text[])
returns table (id uuid, name text, domain text, member_count bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select o.id, o.name, d.domain, p.people
  from organization_domains d
  join organizations o on o.id = d.org_id
  cross join lateral (select org_people(o.id) as people) p
  where d.domain = any (domains) and p.people > 0
  order by d.domain
$$;

revoke all on function domain_orgs(text[]) from public, anon, authenticated;
grant execute on function domain_orgs(text[]) to service_role;

-- Making a team org (20261028120000_team_orgs.sql), now taking its domain
-- over from an org with no people left. One with people still refuses it with
-- unique_violation on organization_domains_pkey, as before.
create or replace function create_team_org(org_name text, creator uuid, claimed_domain text)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  org uuid;
begin
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

revoke all on function create_team_org(text, uuid, text) from public, anon, authenticated;
grant execute on function create_team_org(text, uuid, text) to service_role;
