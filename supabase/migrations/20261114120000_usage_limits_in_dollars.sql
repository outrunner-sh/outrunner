-- Usage-based billing, step one: an org's usage controls in dollars
-- (lib/billing/usage-controls.ts), and where a failed overage payment is
-- recorded (lib/billing/standing.ts), for team and personal orgs alike.
--
-- A plan now includes cloud usage worth its price and bills usage past it at
-- the overage rate (lib/billing/usage.ts), so the admins' limit is a dollar
-- amount that may sit above what the plan includes:
--
-- - usage_limit_usd: what the org may spend on cloud usage in a period,
--   included and overage together; none: no limit. At it, no box starts, and
--   running ones pause. The API keeps it at or above what the plan includes.
-- - alert_thresholds: shares of the plan's included usage, now up to 200%.
--
-- A limit set as a share of the plan's hours (usage_limit_percent) has no
-- dollar meaning under the new plans; rather than guess one, it becomes an
-- alert at the largest threshold not above it (at least 50%), and the
-- column goes.
-- ---------------------------------------------------------------------------

alter table organization_settings
  add column if not exists usage_limit_usd numeric(12, 2) check (usage_limit_usd > 0);

alter table organization_settings
  drop constraint if exists organization_settings_alert_thresholds_check;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organization_settings' and column_name = 'usage_limit_percent'
  ) then
    update organization_settings
    set alert_thresholds = (
      select array_agg(distinct t order by t)
      from unnest(
        alert_thresholds || case
          when usage_limit_percent >= 100 then 100
          when usage_limit_percent >= 80 then 80
          else 50
        end
      ) as t
    )
    where usage_limit_percent is not null;
    alter table organization_settings drop column usage_limit_percent;
  end if;
end $$;

alter table organization_settings
  add constraint organization_settings_alert_thresholds_check
    check (alert_thresholds <@ array[50, 80, 100, 150, 200]);

-- A personal org's admin (its owner) now sets its usage controls too: its
-- plan may bill overage like a team's. Its session defaults stay its
-- owner's own (20261030150000_org_defaults.sql), so the guard now refuses
-- only a personal org's row that sets one of those, not one that holds just
-- usage controls.
create or replace function organization_settings_team_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.default_model is not null or new.box_size is not null or new.archive_on_close is distinct from true)
     and exists (select 1 from organizations where id = new.org_id and personal_owner_id is not null) then
    raise exception 'a personal org''s defaults are its owner''s own' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Since when an overage payment on the subscription has been failing; null
-- while paid up. Stripe's invoice webhooks set and clear it; while it's set,
-- no box starts or wakes, and running ones carry on.
alter table subscriptions
  add column if not exists overage_unpaid_since timestamptz;
