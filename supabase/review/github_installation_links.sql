-- READ-ONLY review of existing GitHub installation links, for audit finding 1
-- (installation re-sharing). Run it against production inside a read-only
-- transaction; it changes nothing:
--
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/review/github_installation_links.sql
--
-- One row per org link of every installation that is either linked to more
-- than one org, or whose link wasn't made by its verified GitHub installer.
-- `verdict` says how the link fares under the rule of
-- 20261112130000_github_installation_sharing.sql (a new link needs the
-- GitHub installer, or a GitHub owner of the installation's account):
--
--   ok: installer          made by the GitHub user who installed it
--   review: not installer  made by an Outrunner admin who isn't the recorded
--                          installer; valid only if they own the GitHub
--                          account/org (check on GitHub), else remove it from
--                          the source org's Settings → GitHub → Shared with
--   review: unknown linker its creator's account is gone
--
-- Existing links are NOT changed by the migration; this is for a person to
-- review.
begin read only;

with links as (
  select l.installation_id, l.org_id, l.installed_by, l.created_at,
         count(*) over (partition by l.installation_id) as orgs_linked,
         row_number() over (partition by l.installation_id order by l.created_at, l.org_id) = 1 as is_source
  from org_github_installations l
),
linker_github as (
  -- Every GitHub account Outrunner has verified as the user's: their GitHub
  -- sign-in identity, and their GitHub connection (Settings → Connections).
  select user_id, array_agg(distinct github_id) as github_ids
  from (
    select i.user_id, (i.provider_id)::bigint as github_id
    from auth.identities i where i.provider = 'github' and i.provider_id ~ '^[0-9]+$'
    union
    select c.user_id, c.github_user_id from user_github_connections c
  ) ids
  group by user_id
)
select
  l.installation_id,
  gi.account_login,
  gi.account_type,
  gi.installer_login,
  l.org_id,
  o.name as org_name,
  (o.personal_owner_id is not null) as personal_org,
  l.is_source,
  l.orgs_linked,
  l.created_at as linked_at,
  u.email as linked_by,
  coalesce(m.role, '(not a member)') as linker_role_now,
  case
    when l.installed_by is null then 'review: unknown linker'
    when gi.installer_id = any(coalesce(g.github_ids, '{}')) then 'ok: installer'
    else 'review: not installer'
  end as verdict
from links l
join github_installations gi using (installation_id)
join organizations o on o.id = l.org_id
left join auth.users u on u.id = l.installed_by
left join linker_github g on g.user_id = l.installed_by
left join organization_members m on m.org_id = l.org_id and m.user_id = l.installed_by
where l.orgs_linked > 1
   or l.installed_by is null
   or not (gi.installer_id = any(coalesce(g.github_ids, '{}')))
order by l.installation_id, l.created_at;

-- Installations whose authorization history names orgs no longer linked:
-- before this migration, any of those orgs' admins could re-link without
-- GitHub's say. Listed for completeness; after the migration it grants nothing.
select gi.installation_id, gi.account_login, o.id as org_id, o.name as org_name
from github_installations gi
cross join lateral unnest(gi.connected_org_ids) as h(org_id)
join organizations o on o.id = h.org_id
where not exists (select 1 from org_github_installations l
                  where l.installation_id = gi.installation_id and l.org_id = h.org_id)
order by gi.installation_id;

rollback;
