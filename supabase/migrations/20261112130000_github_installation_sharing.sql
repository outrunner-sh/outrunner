-- SECURITY: GitHub installation sharing needs GitHub's say, not Outrunner's.
--
-- Before this, link_github_installation (20261104100000) let any admin of an
-- org connected to an installation link it into any other org they
-- administer, their personal org included, and connected_org_ids (which only
-- grows) let a once-connected org be re-linked with no further check. A
-- removed admin kept their own org's link, and so repo-scoped tokens to the
-- customer's private repositories, with nothing the customer could see or
-- revoke in Outrunner.
--
-- Now:
-- - Every new org link needs the GitHub installer, or a GitHub owner of the
--   installation's account (the account itself for a user account; an
--   organization owner for an organization), as GitHub says. The server asks
--   GitHub (lib/github/installation-owner.ts) and names what it verified;
--   this function is service_role-only, so only the server can say so.
--   Outrunner admin status of another connected org grants nothing, and
--   connected_org_ids is history only: it no longer grants a re-link.
-- - Each link records how it was authorized (authority, authorized_github_id).
--   Links from before this are left as they are (authority null): the review
--   query in supabase/review/github_installation_links.sql lists them.
-- - A member leaving or removed from an org takes with them the links they
--   made of its installations into other orgs.
-- - The source org can list and remove the other orgs it's shared with
--   (github_installation_shares, remove_github_installation_share). It's
--   recorded (github_installations.source_org_id), not derived: the first org
--   linked, by GitHub's say, and it doesn't move when it disconnects, so a
--   share can never become the source by outliving it. Only an uninstall (the
--   row goes) or the source org's deletion clears it; then the next org
--   GitHub's installer or owner links becomes the source.
begin;

alter table org_github_installations
  add column authority text check (authority in ('installer', 'account_owner', 'org_owner')),
  add column authorized_github_id bigint;
comment on column org_github_installations.authority is
  'How GitHub authorized this link: the installer, the user account itself, or an owner of the GitHub organization. Null: made before 20261112130000.';

-- The org an installation was first linked to: the one that sees and
-- manages its shares. Existing installations: their earliest link (in
-- production, each made by its GitHub installer).
alter table github_installations
  add column source_org_id uuid references organizations (id) on delete set null;
update github_installations g set source_org_id = (
  select l.org_id from org_github_installations l
  where l.installation_id = g.installation_id
  order by l.created_at, l.org_id limit 1
);

drop function if exists link_github_installation(uuid, bigint, bigint, uuid);

-- verified_owner: what the server verified with GitHub about github_user_id
-- ('account_owner', 'org_owner'), or null. Being the recorded installer is
-- checked here.
create function link_github_installation(
  target_org uuid,
  target_installation bigint,
  github_user_id bigint,
  actor_id uuid,
  verified_owner text default null
)
returns text language plpgsql set search_path = public as $$
declare
  installer bigint;
  how text;
begin
  select installer_id into installer from github_installations
  where installation_id = target_installation for update;
  if not found then return 'unknown'; end if;
  if not exists (select 1 from organization_members
                 where org_id = target_org and user_id = actor_id and role = 'admin') then
    return 'not_admin';
  end if;
  if exists (select 1 from org_github_installations
             where org_id = target_org and installation_id = target_installation) then
    return null;
  end if;
  if github_user_id is null then return 'not_installer'; end if;
  if installer is not null and github_user_id = installer then
    how := 'installer';
  elsif verified_owner in ('account_owner', 'org_owner') then
    how := verified_owner;
  else
    return 'not_installer';
  end if;
  insert into org_github_installations (org_id, installation_id, installed_by, authority, authorized_github_id)
  values (target_org, target_installation, actor_id, how, github_user_id) on conflict do nothing;
  -- The first org linked by GitHub's say is the source; it stays so.
  update github_installations set source_org_id = target_org
  where installation_id = target_installation and source_org_id is null;
  return null;
end;
$$;
revoke all on function link_github_installation(uuid, bigint, bigint, uuid, text) from public, anon, authenticated;
grant execute on function link_github_installation(uuid, bigint, bigint, uuid, text) to service_role;

-- A member leaving or removed from an org: the links they made of its
-- installations into other orgs go too. A user's own account's installation,
-- linked by its owner, stays: nobody but them could have made it. A link from
-- before this (authority null) was vouched for by no one, and goes.
create function drop_departed_member_github_links() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from org_github_installations l
  using github_installations i
  where i.installation_id = l.installation_id
    and l.installed_by = old.user_id
    and l.org_id <> old.org_id
    and exists (select 1 from org_github_installations src
                where src.installation_id = l.installation_id and src.org_id = old.org_id)
    and not (i.account_type = 'User' and coalesce(l.authority, '') in ('installer', 'account_owner'));
  return old;
end;
$$;
revoke all on function drop_departed_member_github_links() from public, anon, authenticated;
create trigger organization_members_drop_github_links after delete on organization_members
for each row execute function drop_departed_member_github_links();

-- The installation's source org, while it's still linked: only it sees, and
-- can remove, the others. Disconnected, it manages nothing until it's linked
-- again (which needs GitHub's say), and no other org takes its place.
create function github_installation_source(target_installation bigint)
returns uuid language sql stable set search_path = public as $$
  select g.source_org_id from github_installations g
  where g.installation_id = target_installation
    and exists (select 1 from org_github_installations l
                where l.installation_id = g.installation_id and l.org_id = g.source_org_id)
$$;
revoke all on function github_installation_source(bigint) from public, anon, authenticated;
grant execute on function github_installation_source(bigint) to service_role;

-- The other orgs an installation is shared with, for its source org; no rows
-- for any other org.
create function github_installation_shares(source_org uuid, target_installation bigint)
returns table (org_id uuid, org_name text, personal boolean, linked_at timestamptz,
               linked_by uuid, linked_by_email text, authority text)
language sql stable security definer set search_path = public as $$
  select l.org_id, o.name, o.personal_owner_id is not null, l.created_at,
         l.installed_by, u.email::text, l.authority
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

-- Remove a share, as the source org: 'not_source' when source_org isn't,
-- 'not_shared' when target_org has no link, null when removed. Locked with
-- linking, so the source can't change under it.
create function remove_github_installation_share(source_org uuid, target_installation bigint, target_org uuid)
returns text language plpgsql set search_path = public as $$
begin
  perform 1 from github_installations where installation_id = target_installation for update;
  if not found then return 'not_shared'; end if;
  if target_org = source_org or github_installation_source(target_installation) is distinct from source_org then
    return 'not_source';
  end if;
  delete from org_github_installations where installation_id = target_installation and org_id = target_org;
  if not found then return 'not_shared'; end if;
  return null;
end;
$$;
revoke all on function remove_github_installation_share(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function remove_github_installation_share(uuid, bigint, uuid) to service_role;

-- The org-scoped view, with how each link was authorized.
create or replace view org_github_installation_details with (security_invoker = true) as
select l.org_id, l.installed_by, l.created_at,
       i.installation_id, i.account_login, i.account_type, i.repository_selection,
       i.suspended_at, i.installer_id, i.installer_login, i.updated_at, i.connected_org_ids,
       l.authority
from org_github_installations l
join github_installations i using (installation_id);
revoke all on table org_github_installation_details from anon, authenticated;
grant select on table org_github_installation_details to service_role;

commit;
