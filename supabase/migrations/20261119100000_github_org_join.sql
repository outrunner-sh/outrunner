-- Joining a team org as a member of its GitHub organization.
--
-- An org whose GitHub App installation is on a GitHub organization, and is
-- that installation's source org (20261112130000_github_installation_sharing.sql),
-- lets that GitHub organization's active members join it at once, as members,
-- without an admin's approval: what "New team org" offers someone it finds
-- there (lib/orgs/github-join.ts). Its admins can turn that off
-- (`organization_settings.join_via_github`). Only the source org counts: an
-- installation shared into other orgs lets no one into them.
--
-- The server asks GitHub first, as the installation (GET
-- /orgs/{org}/memberships/{username}, which needs the App's Members: Read),
-- and calls join_org_via_github only when GitHub said they're an active
-- member. This checks everything Outrunner itself knows, under a lock on the
-- org. Leaving the GitHub organization later takes no one out: admins remove
-- people as they would anyone else.
--
-- Someone an admin removed can't let themselves back in this way: an invite
-- brings them back, as before. Someone who left on their own can.
-- ---------------------------------------------------------------------------

alter table organization_settings add column if not exists join_via_github boolean not null default true;

-- The GitHub organization someone joined through, by its login then; null
-- for an invite, an approved request, or the org's maker. Shown to admins on
-- Settings → Org → Members.
alter table organization_members add column if not exists joined_via_github text;

-- 'joined' (now a member), 'member' (one already), or why not: 'personal',
-- 'disabled', 'not_source', 'removed'.
create or replace function join_org_via_github(target_org uuid, member uuid, github_org text, target_installation bigint)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  personal uuid;
begin
  -- Locked, so two joins at once (two tabs), or a join and the org's
  -- deletion, go one after the other.
  select personal_owner_id into personal from organizations where id = target_org for update;
  if not found then
    return 'not_source';
  end if;
  if personal is not null then
    return 'personal';
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

revoke all on function join_org_via_github(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function join_org_via_github(uuid, uuid, text, bigint) to service_role;
