-- One org kind, step three: personal_owner_id goes. Every org has been an
-- ordinary one since 20261120140000_one_org_kind.sql emptied it, and the app
-- no longer reads it. What still named it is rewritten first, less what only
-- a personal org could do; each is otherwise as it was.
-- ---------------------------------------------------------------------------

-- Joining through GitHub (20261119100000_github_org_join.sql), less the
-- 'personal' refusal: no org is anyone's own alone.
create or replace function join_org_via_github(target_org uuid, member uuid, github_org text, target_installation bigint)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Locked, so two joins at once (two tabs), or a join and the org's
  -- deletion, go one after the other.
  perform 1 from organizations where id = target_org for update;
  if not found then
    return 'not_source';
  end if;
  if not coalesce((select s.join_via_github from organization_settings s where s.org_id = target_org), true) then
    return 'disabled';
  end if;
  -- The installation is on that GitHub organization, the org is its source,
  -- and still has it connected.
  if not exists (
    select 1 from github_installations g
    where g.installation_id = target_installation
      and g.source_org_id = target_org
      and g.account_type = 'Organization'
      and lower(g.account_login) = lower(github_org)
      and g.suspended_at is null
      and exists (select 1 from org_github_installations l
                  where l.installation_id = g.installation_id and l.org_id = target_org)
  ) then
    return 'not_source';
  end if;
  if exists (select 1 from organization_members where org_id = target_org and user_id = member) then
    return 'member';
  end if;
  -- Taken out by someone else: only an invite brings them back.
  if exists (select 1 from organization_removals r
             where r.org_id = target_org and r.user_id = member and r.removed_by is distinct from member) then
    return 'removed';
  end if;
  insert into organization_members (org_id, user_id, role, joined_via_github)
  values (target_org, member, 'member', github_org);
  -- Back within the time a departure keeps their sessions: theirs again
  -- (lib/orgs/removal.ts), as add_org_member does.
  delete from organization_removals where org_id = target_org and user_id = member;
  return 'joined';
end;
$$;

-- The orgs an installation is shared with
-- (20261112130000_github_installation_sharing.sql), less the `personal`
-- column: a different result needs the function made again.
drop function if exists github_installation_shares(uuid, bigint);
create function github_installation_shares(source_org uuid, target_installation bigint)
returns table (
  org_id uuid, org_name text, linked_at timestamptz, linked_by uuid, linked_by_email text, authority text
)
language sql
stable
security definer
set search_path = public
as $$
  select l.org_id, o.name, l.created_at, l.installed_by, u.email::text, l.authority
  from org_github_installations l
  join organizations o on o.id = l.org_id
  left join auth.users u on u.id = l.installed_by
  where l.installation_id = target_installation
    and l.org_id <> source_org
    and github_installation_source(target_installation) = source_org
  order by l.created_at, l.org_id
$$;

revoke all on function github_installation_shares(uuid, bigint) from public, anon, authenticated;
grant execute on function github_installation_shares(uuid, bigint) to service_role;

-- Making another org (20261120130000_own_org_on_sign_in.sql): every org a
-- creator made counts against their one Free one.
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
  if not may_make_another and exists (select 1 from organizations o where o.created_by = creator) then
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

alter table organizations drop column if exists personal_owner_id;
