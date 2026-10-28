-- An org's connector (20261031120000_org_connectors.sql) runs its
-- automations on its own plan, paid by the deployment: its boxes take no
-- room in the org's plan (20261031150000_org_billing.sql), and the org's
-- members' boxes none of the connector's. Its cap is counted over its own
-- boxes, as every user's was before billing was the org's.
-- ---------------------------------------------------------------------------

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
    and owner_id not in (select user_id from org_connectors where org_id = for_org)
    and not pooled
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;
revoke all on function live_org_computers(uuid) from public, anon, authenticated;

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
  -- The org's connector: its own plan, over its own boxes.
  if exists (select 1 from org_connectors where org_id = for_org and user_id = auth.uid()) then
    perform pg_advisory_xact_lock(hashtext('claim_runtime_computer:' || auth.uid()::text));
    if live_metered_computers(auth.uid()) >= max_live then
      raise exception 'Automations'' % concurrent cloud sessions are already running. One ends when its run does.', max_live
        using errcode = 'P4BX1';
    end if;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('org_box_cap:' || for_org::text));
  if live_org_computers(for_org) >= max_live then
    raise exception 'Your org''s plan''s % concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.', max_live
      using errcode = 'P4BX1';
  end if;
end $$;
revoke all on function check_org_box_cap(uuid, integer) from public, anon;
grant execute on function check_org_box_cap(uuid, integer) to authenticated;
