-- One GitHub installation can serve multiple Outrunner organizations.
-- Keep installation metadata global, and access in explicit per-org links.
begin;

create table org_github_installations (
  org_id uuid not null references organizations (id) on delete cascade,
  installation_id bigint not null references github_installations (installation_id) on delete cascade,
  installed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, installation_id)
);
create index org_github_installations_installation_idx on org_github_installations (installation_id);
alter table org_github_installations enable row level security;
revoke all on table org_github_installations from anon, authenticated;

insert into org_github_installations (org_id, installation_id, installed_by, created_at)
select org_id, installation_id, installed_by, created_at
from github_installations where org_id is not null;

alter table github_installations drop constraint github_installations_claimable;
alter table github_installations drop column org_id, drop column installed_by, drop column removed_from;
drop index if exists github_installations_installer_idx;
create index github_installations_installer_idx on github_installations (installer_id);

-- A service-role-only view for existing org-scoped consumers.
create view org_github_installation_details with (security_invoker = true) as
select l.org_id, l.installed_by, l.created_at,
       i.installation_id, i.account_login, i.account_type, i.repository_selection,
       i.suspended_at, i.installer_id, i.installer_login, i.updated_at
from org_github_installations l
join github_installations i using (installation_id);
revoke all on table org_github_installation_details from anon, authenticated;
grant select on table org_github_installation_details to service_role;
grant all on table org_github_installations to service_role;

-- Serialize linking with uninstalls. An admin of a connected org may share
-- its access with another org they administer. A first connection requires
-- the verified GitHub installer. An installation id alone grants nothing.
create function link_github_installation(target_org uuid, target_installation bigint, github_user_id bigint, actor_id uuid)
returns text language plpgsql set search_path = public as $$
declare
  installer bigint;
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
  if exists (select 1 from org_github_installations where installation_id = target_installation) then
    if not exists (
      select 1 from org_github_installations l join organization_members m on m.org_id = l.org_id
      where l.installation_id = target_installation and m.user_id = actor_id and m.role = 'admin'
    ) then return 'not_admin'; end if;
  elsif installer is null or github_user_id is distinct from installer then
    return 'not_installer';
  end if;
  insert into org_github_installations (org_id, installation_id, installed_by)
  values (target_org, target_installation, actor_id) on conflict do nothing;
  return null;
end;
$$;
revoke all on function link_github_installation(uuid, bigint, bigint, uuid) from public, anon, authenticated;
grant execute on function link_github_installation(uuid, bigint, bigint, uuid) to service_role;

commit;
