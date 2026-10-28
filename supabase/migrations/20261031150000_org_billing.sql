-- Orgs, step ten: billing is the org's (decision 3). Its plan, from its
-- Stripe subscription, sets what all its members' sessions share: cloud
-- hours, boxes running at once, the largest box. Seats don't count.
--
-- - billing_customers and subscriptions belong to an org. Each one a user
--   has today is their personal org's, so solo users keep their plan.
-- - compute_intervals record the org a box ran for, so its hours are the
--   org's; one from before is its computer's org, else its owner's personal
--   org.
-- - The box cap counts the org's boxes, every member's, under a lock per
--   org: check_org_box_cap, which both claims call with their project's org.
--
-- The model allowance stays each user's until the next step.
-- ---------------------------------------------------------------------------

-- Customers: one per org. The user who made it stays, for Stripe's metadata.
alter table billing_customers add column if not exists org_id uuid references organizations (id) on delete restrict;
update billing_customers c set org_id = o.id
from organizations o
where o.personal_owner_id = c.user_id and c.org_id is null;
alter table billing_customers alter column org_id set not null;
alter table billing_customers drop constraint if exists billing_customers_pkey;
alter table billing_customers add primary key (org_id);
alter table billing_customers alter column user_id drop not null;
create index if not exists billing_customers_user_idx on billing_customers (user_id);

-- Subscriptions: the org's.
alter table subscriptions add column if not exists org_id uuid references organizations (id) on delete restrict;
update subscriptions s set org_id = o.id
from organizations o
where o.personal_owner_id = s.user_id and s.org_id is null;
alter table subscriptions alter column org_id set not null;
alter table subscriptions alter column user_id drop not null;
create index if not exists subscriptions_org_idx on subscriptions (org_id);

-- Hours: the org a box ran for.
alter table compute_intervals add column if not exists org_id uuid references organizations (id) on delete cascade;
update compute_intervals i set org_id = c.org_id
from runtime_computers c
where c.id = i.computer_id and i.org_id is null;
update compute_intervals i set org_id = o.id
from organizations o
where o.personal_owner_id = i.owner_id and i.org_id is null;
create index if not exists compute_intervals_org_started_idx on compute_intervals (org_id, started_at);

-- How many of the org's boxes, every member's, the plan limits are running.
-- As live_metered_computers, over the org; the server's and the claims'
-- alone (a member may not see the others' boxes).
create or replace function live_org_computers(for_org uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from runtime_computers
  where org_id = for_org
    and not pooled
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;
revoke all on function live_org_computers(uuid) from public, anon, authenticated;

-- Refuse a claim that would start a box past the org's plan's cap, under a
-- lock per org, so count-then-claim is one transaction for all its members.
-- Only for the caller's own org.
create or replace function check_org_box_cap(for_org uuid, max_live integer)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if max_live is null then
    return;
  end if;
  if for_org is null or not is_org_member(for_org) then
    raise exception 'org not found';
  end if;
  perform pg_advisory_xact_lock(hashtext('org_box_cap:' || for_org::text));
  if live_org_computers(for_org) >= max_live then
    raise exception 'Your org''s plan''s % concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.', max_live
      using errcode = 'P4BX1';
  end if;
end $$;
revoke all on function check_org_box_cap(uuid, integer) from public, anon;
grant execute on function check_org_box_cap(uuid, integer) to authenticated;

-- Both claims, with the org's cap in place of the user's. Otherwise as
-- 20261030110000_claims_answer_once.sql.
create or replace function claim_workspace_computer(
  requested_workspace_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1',
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  for_project uuid;
  for_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select project_id, org_id into for_project, for_org
  from workspaces
  where id = requested_workspace_id
    and owner_id = auth.uid()
    and status not in ('destroying', 'destroyed');

  if not found then
    raise exception 'workspace not found';
  end if;

  perform pg_advisory_xact_lock(hashtext('workspace_computer:' || requested_workspace_id::text));

  select * into existing
  from runtime_computers
  where workspace_id = requested_workspace_id;

  if found then
    if existing.status in ('error', 'stopped') then
      perform check_org_box_cap(for_org, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
      return;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_org_box_cap(for_org, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    workspace_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    for_project,
    requested_workspace_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;

create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1',
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  for_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select org_id into for_org
  from projects
  where id = requested_project_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'project not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_project_id::text));

  select * into existing
  from runtime_computers
  where project_id = requested_project_id
    and workspace_id is null
    and not pooled;

  if found then
    if existing.status in ('error', 'stopped') then
      perform check_org_box_cap(for_org, max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
      return;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_org_box_cap(for_org, max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    requested_project_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;
