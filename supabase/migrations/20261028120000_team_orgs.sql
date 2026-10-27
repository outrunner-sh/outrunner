-- Orgs, step two: team orgs. A user may make one team org beside their
-- personal one; it claims their email's domain, so the next person from that
-- domain asks to join it rather than making another.
-- ---------------------------------------------------------------------------

-- One project per repository per org only: one user may now have the same
-- repository in their personal org and a team org. Kept until now for the
-- app from before 20261027120000 (see there).
alter table projects drop constraint if exists projects_owner_repo_unique;

-- One team org per user, for now: every org is on the Free plan until billing
-- moves to orgs, and a second would be a second free allowance. Personal orgs
-- (personal_owner_id set) aren't counted.
create unique index if not exists organizations_one_team_org_per_creator
  on organizations (created_by) where personal_owner_id is null;

-- The domain a team org claimed: its creator's verified email's, never a free
-- mail provider's (the server decides which). One org per domain. Service
-- role only, like organization_members' writes: lib/db/orgs.ts.
create table if not exists organization_domains (
  domain text primary key check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  org_id uuid not null references organizations (id) on delete cascade,
  claimed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists organization_domains_org_idx on organization_domains (org_id);

alter table organization_domains enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table organization_domains from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A warm pool per member: a pooled box is made with its maker's GitHub token
-- and taken only by them (claim_pooled_computer), so each member of a team
-- org gets their own, one per project.
-- ---------------------------------------------------------------------------

drop index if exists runtime_computers_pool_project_unique;
create unique index if not exists runtime_computers_pool_project_owner_unique
  on runtime_computers (project_id, owner_id) where pooled;

-- ---------------------------------------------------------------------------
-- The signed-in user's orgs, for policies: `org_id in (select my_org_ids())`
-- is worked out once per query, where is_org_member(org_id) ran per row.
-- SECURITY DEFINER for the reason is_org_member is.
-- ---------------------------------------------------------------------------

create or replace function my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from public.organization_members m where m.user_id = auth.uid()
$$;

drop policy if exists organizations_member_read on organizations;
create policy organizations_member_read on organizations
  for select using (id in (select my_org_ids()));

drop policy if exists projects_member_read on projects;
drop policy if exists projects_owner_insert on projects;
drop policy if exists projects_owner_update on projects;
drop policy if exists projects_owner_delete on projects;
create policy projects_member_read on projects
  for select using (org_id in (select my_org_ids()));
create policy projects_owner_insert on projects
  for insert with check (auth.uid() = owner_id and org_id in (select my_org_ids()));
create policy projects_owner_update on projects
  for update using (auth.uid() = owner_id and org_id in (select my_org_ids()))
  with check (auth.uid() = owner_id and org_id in (select my_org_ids()));
create policy projects_owner_delete on projects
  for delete using (auth.uid() = owner_id and org_id in (select my_org_ids()));

drop policy if exists workspaces_owner_all on workspaces;
create policy workspaces_owner_all on workspaces
  for all using (auth.uid() = owner_id and org_id in (select my_org_ids()))
  with check (auth.uid() = owner_id and org_id in (select my_org_ids()));

drop policy if exists runtime_computers_owner_all on runtime_computers;
create policy runtime_computers_owner_all on runtime_computers
  for all using (auth.uid() = owner_id and org_id in (select my_org_ids()))
  with check (auth.uid() = owner_id and org_id in (select my_org_ids()));

-- ---------------------------------------------------------------------------
-- Making a team org: the org, its creator as admin, and its domain, all or
-- none. For the server alone (service role), which has checked the domain is
-- the creator's verified email's and no free mail provider's. A second team
-- org by the same creator, or a domain another org has, fails with
-- unique_violation: the constraint's name says which.
-- ---------------------------------------------------------------------------

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
    insert into organization_domains (domain, org_id, claimed_by)
    values (claimed_domain, org, creator);
  end if;
  return org;
end;
$$;

revoke all on function create_team_org(text, uuid, text) from public, anon, authenticated;
grant execute on function create_team_org(text, uuid, text) to service_role;
