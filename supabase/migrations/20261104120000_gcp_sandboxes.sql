-- Customer-scoped keyless GCP connections and a durable resource ledger.
-- Service-role only: CLI and browser routes enforce ownership before access.
create table gcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'),
  project_number text not null check (project_number ~ '^[1-9][0-9]{4,20}$'),
  zone text not null check (zone ~ '^[a-z]+-[a-z]+[0-9]+-[a-z]$'),
  state text not null default 'pending' check (state in ('pending', 'connected', 'revoked')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (user_id, project_id, zone)
);
alter table gcp_connections enable row level security;
revoke all on gcp_connections from anon, authenticated;
grant all on gcp_connections to service_role;

create table gcp_resources (
  id uuid primary key,
  connection_id uuid not null references gcp_connections(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  instance_name text not null,
  instance_id text,
  state text not null default 'creating' check (state in ('creating', 'ready', 'stopped', 'deleting', 'deleted')),
  probe boolean not null default false,
  created_at timestamptz not null default now(),
  cleanup_attempted_at timestamptz,
  unique (connection_id, instance_name)
);
create unique index gcp_resources_one_probe_idx on gcp_resources(connection_id) where probe and state <> 'deleted';
create index gcp_resources_cleanup_idx on gcp_resources((coalesce(cleanup_attempted_at, created_at)), id) where state <> 'deleted';
alter table gcp_resources enable row level security;
revoke all on gcp_resources from anon, authenticated;
grant all on gcp_resources to service_role;

alter table user_credentials add column gcp_connection_id uuid references gcp_connections(id) on delete restrict;
alter table user_credentials drop constraint user_credentials_sandbox_check;
alter table user_credentials add constraint user_credentials_sandbox_check check (sandbox in ('outrunner', 'daytona', 'modal', 'gcp'));

create or replace function live_metered_computers(for_owner uuid)
returns bigint language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*) from runtime_computers
  where owner_id = for_owner
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal', 'user-gcp'))
    and (status = 'ready' or (status = 'provisioning' and updated_at > now() - interval '10 minutes'))
$$;
create or replace function live_org_computers(for_org uuid)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) from runtime_computers
  where org_id = for_org
    and owner_id not in (select user_id from org_connectors where org_id = for_org)
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal', 'user-gcp'))
    and (status = 'ready' or (status = 'provisioning' and updated_at > now() - interval '10 minutes'))
$$;
revoke all on function live_org_computers(uuid) from public, anon, authenticated;

-- Serialise connection selection/revocation with resource creation. A disconnect
-- can never pass its empty-ledger check while a new VM intent is being added.
create function check_gcp_resource_connection() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare c gcp_connections%rowtype;
begin
  select * into c from gcp_connections where id = new.connection_id for update;
  if not found or c.user_id <> new.user_id or c.state = 'revoked' or (not new.probe and c.state <> 'connected') then
    raise exception 'Google Cloud connection is unavailable';
  end if;
  return new;
end $$;
create trigger gcp_resource_connection_guard before insert on gcp_resources for each row execute function check_gcp_resource_connection();
revoke all on function check_gcp_resource_connection() from public, anon, authenticated;

create function select_gcp_connection(for_owner uuid, for_connection uuid, requested_size text default null)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform 1 from gcp_connections where id = for_connection and user_id = for_owner and state = 'connected' for update;
  if not found then raise exception 'Test the Google Cloud connection before using it'; end if;
  if requested_size is not null and requested_size not in ('small', 'medium', 'large') then raise exception 'Unsupported GCP sandbox size'; end if;
  insert into user_credentials(user_id, sandbox, gcp_connection_id, box_size, box_size_chosen)
  values (for_owner, 'gcp', for_connection, coalesce(requested_size, 'small'), requested_size is not null)
  on conflict(user_id) do update set sandbox = 'gcp', gcp_connection_id = for_connection,
    box_size = coalesce(requested_size, case when user_credentials.box_size = 'x-small' then 'small' else user_credentials.box_size end),
    box_size_chosen = case when requested_size is null then user_credentials.box_size_chosen else true end;
end $$;
revoke all on function select_gcp_connection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function select_gcp_connection(uuid, uuid, text) to service_role;

create function disconnect_gcp_connection(for_owner uuid, for_connection uuid)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform 1 from gcp_connections where id = for_connection and user_id = for_owner for update;
  if not found then raise exception 'Google Cloud connection not found'; end if;
  if exists(select 1 from gcp_resources where connection_id = for_connection and state <> 'deleted') then
    raise exception 'Delete this connection''s Google Cloud sessions before disconnecting. Their VMs and disks still need its access.';
  end if;
  update user_credentials set
    sandbox = case when sandbox = 'gcp' and (gcp_connection_id is null or gcp_connection_id = for_connection) then 'outrunner' else sandbox end,
    gcp_connection_id = case when gcp_connection_id = for_connection then null else gcp_connection_id end
  where user_id = for_owner;
  update gcp_connections set state = 'revoked' where id = for_connection;
end $$;
revoke all on function disconnect_gcp_connection(uuid, uuid) from public, anon, authenticated;
grant execute on function disconnect_gcp_connection(uuid, uuid) to service_role;

-- Claim a bounded batch and rotate it behind older attempts even when Google
-- access is revoked or a worker crashes. Cooldown and row locks prevent
-- overlapping cron runs from immediately retrying the same resources.
create function gcp_cleanup_candidates(older_than timestamptz)
returns setof gcp_resources language sql volatile security invoker set search_path = public, pg_temp as $$
  with candidates as (
    select r.id from gcp_resources r
    where r.state <> 'deleted' and r.created_at < older_than
      and (r.cleanup_attempted_at is null or r.cleanup_attempted_at < now() - interval '5 minutes')
      and (r.state = 'deleting' or not exists (
        select 1 from runtime_computers c where c.provider = 'user-gcp' and c.daytona_sandbox_id = r.id::text
      ))
    order by coalesce(r.cleanup_attempted_at, r.created_at), r.id limit 10
    for update of r skip locked
  )
  update gcp_resources r set cleanup_attempted_at = now()
  from candidates c where r.id = c.id returning r.*
$$;
revoke all on function gcp_cleanup_candidates(timestamptz) from public, anon, authenticated;
grant execute on function gcp_cleanup_candidates(timestamptz) to service_role;
