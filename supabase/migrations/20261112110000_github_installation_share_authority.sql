-- Shared GitHub installations: every link records the authority it was made
-- with, and a share lasts only as long as that authority does.
--
-- 20261104100000 let an admin of an org connected to an installation link it
-- to any other org they administer, their personal org included, and nothing
-- ever took that link away again. An admin of a customer's org could copy the
-- customer's installation into their own org and keep App installation tokens
-- for the customer's private repositories after the customer removed them.
-- Worse, the destination then counted as "previously authorized", so even a
-- deleted link could be put back by the same person.
--
-- Now a link is one of:
--
-- - a root link (shared_from_org is null): the verified GitHub installer's
--   first connection; the owner of a GitHub *user* account linking the App's
--   installation on their own account (only they can install there); or an
--   org that held a root link reconnecting (root_org_ids).
-- - a share (shared_from_org set): made by an admin of a connected org
--   (installed_by) into another *team* org they administer. It depends on
--   that source: it is revoked as soon as the sharer stops being an admin of
--   the source org (removed, left, demoted, or their account deleted), and
--   when the source's own link goes (disconnect, org deleted, uninstall),
--   transitively through the foreign key.
--
-- A personal org never receives a share. It gets an installation only as a
-- root link: the one on its owner's own GitHub account, or one its owner
-- installed on GitHub and connected first.
--
-- Existing links are audited below: links that would not be allowed today,
-- or whose sharer has since lost the source org, are revoked and kept in
-- github_installation_link_revocations.
begin;

alter table org_github_installations add column shared_from_org uuid;
alter table org_github_installations
  add constraint org_github_installations_not_from_self check (shared_from_org is distinct from org_id),
  add constraint org_github_installations_shared_from_fkey
    foreign key (shared_from_org, installation_id)
    references org_github_installations (org_id, installation_id) on delete cascade;
create index org_github_installations_shared_from_idx
  on org_github_installations (shared_from_org, installation_id) where shared_from_org is not null;
create index org_github_installations_sharer_idx
  on org_github_installations (installed_by, shared_from_org) where shared_from_org is not null;

-- Orgs that held a root link: only they may reconnect without a live source.
-- connected_org_ids still says the installation was ever connected (no
-- installer "first connection" after that).
alter table github_installations add column root_org_ids uuid[] not null default '{}';

-- What was taken away, and why: the backfill's audit and every revocation
-- after it, for support to explain or restore.
create table github_installation_link_revocations (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  installation_id bigint not null,
  installed_by uuid,
  shared_from_org uuid,
  link_created_at timestamptz,
  reason text not null,
  revoked_at timestamptz not null default now()
);
create index github_installation_link_revocations_org_idx on github_installation_link_revocations (org_id);
alter table github_installation_link_revocations enable row level security;
revoke all on table github_installation_link_revocations from anon, authenticated;
grant select on table github_installation_link_revocations to service_role;

create or replace function remember_github_installation_org() returns trigger
language plpgsql set search_path = public as $$
begin
  update github_installations
  set connected_org_ids = case when new.org_id = any(connected_org_ids) then connected_org_ids
                               else array_append(connected_org_ids, new.org_id) end,
      root_org_ids = case when new.shared_from_org is not null or new.org_id = any(root_org_ids) then root_org_ids
                          else array_append(root_org_ids, new.org_id) end
  where installation_id = new.installation_id;
  return new;
end;
$$;

-- Every share that goes is logged, with why: a revocation's reason, set for
-- the transaction by the function revoking it, and otherwise a disconnect
-- (its own, or its source's, through the foreign key's cascade).
create function log_github_share_removal() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into github_installation_link_revocations (org_id, installation_id, installed_by, shared_from_org, link_created_at, reason)
  values (old.org_id, old.installation_id, old.installed_by, old.shared_from_org, old.created_at,
          coalesce(nullif(current_setting('outrunner.github_share_revocation', true), ''), 'disconnected'));
  return null;
end;
$$;
revoke all on function log_github_share_removal() from public, anon, authenticated;
create trigger org_github_installations_log_share_removal
after delete on org_github_installations
for each row when (old.shared_from_org is not null)
execute function log_github_share_removal();

-- Revoke the shares `sharer` made from `source_org`, and every share made
-- from those in turn (the foreign key's cascade).
create function revoke_github_installation_shares(source_org uuid, sharer uuid, why text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('outrunner.github_share_revocation', why, true);
  delete from org_github_installations where shared_from_org = source_org and installed_by = sharer;
  perform set_config('outrunner.github_share_revocation', '', true);
end;
$$;
revoke all on function revoke_github_installation_shares(uuid, uuid, text) from public, anon, authenticated;

-- A sharer who stops administering the source org takes their shares with them.
create function revoke_github_shares_on_admin_loss() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform revoke_github_installation_shares(old.org_id, old.user_id, 'sharer_removed');
  elsif old.role = 'admin' and (new.role is distinct from 'admin' or new.org_id <> old.org_id or new.user_id <> old.user_id) then
    perform revoke_github_installation_shares(old.org_id, old.user_id, 'sharer_not_admin');
  end if;
  return null;
end;
$$;
revoke all on function revoke_github_shares_on_admin_loss() from public, anon, authenticated;
create trigger organization_members_revoke_github_shares
after delete or update on organization_members
for each row execute function revoke_github_shares_on_admin_loss();

-- A share whose sharer is gone (their account deleted sets installed_by to
-- null) has no one's authority behind it.
create function revoke_orphaned_github_share() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('outrunner.github_share_revocation', 'sharer_deleted', true);
  delete from org_github_installations where org_id = new.org_id and installation_id = new.installation_id;
  perform set_config('outrunner.github_share_revocation', '', true);
  return null;
end;
$$;
revoke all on function revoke_orphaned_github_share() from public, anon, authenticated;
create trigger org_github_installations_revoke_orphaned_share
after update of installed_by on org_github_installations
for each row when (new.installed_by is null and new.shared_from_org is not null)
execute function revoke_orphaned_github_share();

-- Serialize linking with uninstalls. See the header for who may link.
create or replace function link_github_installation(target_org uuid, target_installation bigint, github_user_id bigint, actor_id uuid)
returns text language plpgsql set search_path = public as $$
declare
  inst github_installations%rowtype;
  personal boolean;
  source uuid;
begin
  select * into inst from github_installations where installation_id = target_installation for update;
  if not found then return 'unknown'; end if;
  if not exists (select 1 from organization_members
                 where org_id = target_org and user_id = actor_id and role = 'admin') then
    return 'not_admin';
  end if;
  if exists (select 1 from org_github_installations
             where org_id = target_org and installation_id = target_installation) then
    return null;
  end if;
  -- A root link: GitHub's own word, or an org that held one before.
  if (inst.installer_id is not null and github_user_id is not distinct from inst.installer_id
      and (cardinality(inst.connected_org_ids) = 0 or inst.account_type = 'User'))
     or target_org = any(inst.root_org_ids) then
    insert into org_github_installations (org_id, installation_id, installed_by)
    values (target_org, target_installation, actor_id);
    return null;
  end if;
  if cardinality(inst.connected_org_ids) = 0 then return 'not_installer'; end if;
  -- A share: never into a personal org, and only from an org the actor
  -- administers now; it lasts while they do (and while the source does).
  -- Their membership row is locked until this commits, so a removal or
  -- demotion running alongside waits and then revokes this share too, or
  -- goes first and leaves no source.
  select personal_owner_id is not null into personal from organizations where id = target_org;
  if personal then return 'personal_org'; end if;
  select l.org_id into source
  from org_github_installations l
  join organization_members m on m.org_id = l.org_id and m.user_id = actor_id and m.role = 'admin'
  where l.installation_id = target_installation
  order by (l.shared_from_org is null) desc, l.created_at
  limit 1
  for share of m;
  if source is null then return 'not_admin'; end if;
  insert into org_github_installations (org_id, installation_id, installed_by, shared_from_org)
  values (target_org, target_installation, actor_id, source);
  return null;
end;
$$;
revoke all on function link_github_installation(uuid, bigint, bigint, uuid) from public, anon, authenticated;
grant execute on function link_github_installation(uuid, bigint, bigint, uuid) to service_role;

create or replace view org_github_installation_details with (security_invoker = true) as
select l.org_id, l.installed_by, l.created_at,
       i.installation_id, i.account_login, i.account_type, i.repository_selection,
       i.suspended_at, i.installer_id, i.installer_login, i.updated_at, i.connected_org_ids,
       l.shared_from_org, i.root_org_ids
from org_github_installations l
join github_installations i using (installation_id);

-- Audit the links made before this migration.
--
-- Roots: the installation's first connected org (connected_org_ids keeps
-- them in order; the first is the pre-sharing org or the installer's first
-- connection), and a link made by the owner of a user-account installation
-- (their GitHub id, from their sign-in or their GitHub connection, is the
-- installer's). Every other link was a share. In creation order, a share is
-- kept, pointed at a source the sharer still administers, only when that
-- source is already kept and the destination is a team org. The rest are
-- revoked.
create temporary table github_link_roots on commit drop as
select l.org_id, l.installation_id
from org_github_installations l
join github_installations i using (installation_id)
where l.org_id = i.connected_org_ids[1]
   or (i.account_type = 'User' and i.installer_id is not null and l.installed_by is not null
       and exists (select 1 from user_github_connections c
                   where c.user_id = l.installed_by and c.github_user_id = i.installer_id));
-- Their GitHub sign-in, too (Supabase's auth.identities; absent from local
-- stand-ins of the auth schema).
do $$
begin
  if to_regclass('auth.identities') is not null then
    execute $q$
      insert into github_link_roots
      select l.org_id, l.installation_id
      from org_github_installations l
      join github_installations i using (installation_id)
      where i.account_type = 'User' and i.installer_id is not null and l.installed_by is not null
        and exists (select 1 from auth.identities a where a.user_id = l.installed_by and a.provider = 'github'
                    and a.provider_id = i.installer_id::text)
    $q$;
  end if;
end;
$$;

update github_installations i set root_org_ids = coalesce((
  select array_agg(distinct r.org_id) from github_link_roots r where r.installation_id = i.installation_id
), '{}') || case when cardinality(i.connected_org_ids) > 0
                  and not exists (select 1 from github_link_roots r where r.installation_id = i.installation_id
                                  and r.org_id = i.connected_org_ids[1])
                 then array[i.connected_org_ids[1]] else '{}'::uuid[] end;

do $$
declare
  link record;
  source uuid;
  why text;
begin
  for link in
    select l.* from org_github_installations l
    where not exists (select 1 from github_link_roots r where r.org_id = l.org_id and r.installation_id = l.installation_id)
    order by l.created_at, l.org_id
  loop
    -- An earlier cascade may have taken it already.
    continue when not exists (select 1 from org_github_installations
                              where org_id = link.org_id and installation_id = link.installation_id);
    source := null;
    why := null;
    if exists (select 1 from organizations where id = link.org_id and personal_owner_id is not null) then
      why := 'personal_org';
    elsif link.installed_by is null then
      why := 'sharer_unknown';
    else
      select s.org_id into source
      from org_github_installations s
      join organization_members m on m.org_id = s.org_id and m.user_id = link.installed_by and m.role = 'admin'
      where s.installation_id = link.installation_id and s.org_id <> link.org_id
        and (s.shared_from_org is not null
             or exists (select 1 from github_link_roots r where r.org_id = s.org_id and r.installation_id = s.installation_id))
      order by (s.shared_from_org is null) desc, s.created_at
      limit 1;
      if source is null then why := 'sharer_not_admin'; end if;
    end if;
    if why is null then
      update org_github_installations set shared_from_org = source
      where org_id = link.org_id and installation_id = link.installation_id;
    else
      insert into github_installation_link_revocations (org_id, installation_id, installed_by, shared_from_org, link_created_at, reason)
      values (link.org_id, link.installation_id, link.installed_by, null, link.created_at, 'backfill:' || why);
      delete from org_github_installations where org_id = link.org_id and installation_id = link.installation_id;
    end if;
  end loop;
end;
$$;

commit;
