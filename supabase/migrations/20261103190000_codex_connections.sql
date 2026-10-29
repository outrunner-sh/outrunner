-- Codex account credentials never leave the service role. Each row is either
-- personal or org-owned; ciphertext authenticates this scope as well.
create table public.codex_connections (
  key text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  revision bigint not null default 0,
  status text not null default 'disconnected' check (status in ('connected','reconnect','disconnected')),
  ciphertext text,
  updated_at timestamptz not null default now(),
  pending_id uuid,
  pending_user uuid references auth.users(id) on delete set null,
  pending_until timestamptz,
  retry_until timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  check ((user_id is not null and org_id is null and key = 'personal:' || user_id::text)
      or (org_id is not null and user_id is null and key = 'org:' || org_id::text))
);
alter table public.codex_connections enable row level security;
revoke all on public.codex_connections from anon, authenticated;
grant all on public.codex_connections to service_role;

-- One transactional operation, including refresh leasing and fenced completion.
-- The application has already checked the caller's current role; only the
-- service role can call this function. No network work holds a DB transaction.
create function public.codex_connection_change(k text, op text, a jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.codex_connections; claimed boolean := false;
begin
  if k !~ '^(org|personal):[0-9a-f-]{36}$' then raise exception 'Invalid scope'; end if;
  insert into codex_connections(key,user_id,org_id)
    values(k, case when k like 'personal:%' then substring(k from 10)::uuid end,
              case when k like 'org:%' then substring(k from 5)::uuid end)
    on conflict do nothing;
  select * into r from codex_connections where key=k for update;
  if op in ('begin','cancel','save','disconnect') then
    if not coalesce((r.user_id=(a->>'actor')::uuid or exists (
      select 1 from organization_members where org_id=r.org_id and user_id=(a->>'actor')::uuid and role='admin'
    )),false) then raise exception 'Not authorized'; end if;
  end if;
  if op='begin' then
    update codex_connections set pending_id=(a->>'attempt')::uuid,
      pending_user=(a->>'actor')::uuid, pending_until=now()+interval '10 minutes' where key=k;
  elsif op='cancel' then
    update codex_connections set pending_id=null,pending_user=null,pending_until=null
      where key=k and pending_id=(a->>'attempt')::uuid;
  elsif op='save' then
    update codex_connections set ciphertext=a->>'ciphertext',status='connected',
      generation=gen_random_uuid(),revision=revision+1,updated_at=now(),
      pending_id=null,pending_user=null,pending_until=null,lease_id=null,lease_until=null,retry_until=null
      where key=k and pending_id=(a->>'attempt')::uuid and pending_user=(a->>'actor')::uuid and pending_until>now();
    claimed := found;
  elsif op='disconnect' then
    update codex_connections set ciphertext=null,status='disconnected',generation=gen_random_uuid(),
      revision=revision+1,updated_at=now(),pending_id=null,pending_user=null,pending_until=null,
      lease_id=null,lease_until=null,retry_until=null where key=k;
  elsif op='lease' then
    update codex_connections set lease_id=(a->>'lease')::uuid,lease_until=now()+interval '60 seconds'
      where key=k and status='connected' and generation=(a->>'generation')::uuid
      and revision=(a->>'revision')::bigint and (retry_until is null or retry_until<now()) and (lease_until is null or lease_until<now());
    claimed := found;
  elsif op in ('finish','reject','release') then
    if r.lease_id=(a->>'lease')::uuid and r.generation=(a->>'generation')::uuid then
      update codex_connections set
        ciphertext=case when op='finish' then a->>'ciphertext' when op='reject' then null else ciphertext end,
        status=case when op='reject' then 'reconnect' else status end,
        revision=case when op='release' then revision else revision+1 end,
        updated_at=case when op='release' then updated_at else now() end,
        lease_id=null,lease_until=null,retry_until=case when op='release' then now()+interval '5 seconds' end where key=k;
      claimed := true;
    end if;
  else raise exception 'Invalid operation';
  end if;
  select * into r from codex_connections where key=k;
  return jsonb_build_object('row',to_jsonb(r),'claimed',claimed);
end $$;
revoke all on function public.codex_connection_change(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.codex_connection_change(text,text,jsonb) to service_role;

alter table public.user_agent_auth drop constraint if exists user_agent_auth_method_check;
alter table public.user_agent_auth add constraint user_agent_auth_method_check
  check (method in ('subscription','chatgpt','local','api-key','codex-account'));

-- One snapshot is the authorization point for each inference request. Avoid
-- a cached membership, or a disconnect hidden between separate awaited reads.
create function public.codex_connection_use(k text, actor uuid, requested_org uuid, gen uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from codex_connections c
    where c.key=k and c.generation=gen and c.status in ('connected','reconnect')
      and ((c.user_id=actor and c.key='personal:' || actor::text)
        or (c.org_id=requested_org and c.key='org:' || requested_org::text))
      and (requested_org is null or exists (
        select 1 from organization_members m where m.org_id=requested_org and m.user_id=actor
      ))
      and not exists (select 1 from user_agent_auth a where a.user_id=actor and a.agent='codex' and a.method<>'codex-account')
      and (c.org_id is null or (
        not exists (select 1 from codex_connections own where own.user_id=actor and own.status<>'disconnected')
        and (exists (select 1 from user_agent_auth a where a.user_id=actor and a.agent='codex' and a.method='codex-account')
          or not exists (select 1 from user_provider_keys p where p.user_id=actor and p.provider='openai'))
      ))
  );
$$;
revoke all on function public.codex_connection_use(text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.codex_connection_use(text,uuid,uuid,uuid) to service_role;
