-- Review fix to 20261029100000 (applied): an installation is kept for an org
-- only by the GitHub user who installed it. GitHub's webhook says who that was
-- (the installation event's sender), and installing on an organization needs
-- one of its owners or App managers. So the webhook records each new
-- installation unclaimed, with its installer; the setup route, or the
-- installer from Settings → Org → GitHub, claims it for an org.
-- ---------------------------------------------------------------------------

alter table github_installations alter column org_id drop not null;
alter table github_installations add column if not exists installer_login text;

-- An unclaimed installation has its installer to claim it.
alter table github_installations drop constraint if exists github_installations_claimable;
alter table github_installations add constraint github_installations_claimable
  check (org_id is not null or installer_login is not null);

create index if not exists github_installations_installer_idx
  on github_installations (lower(installer_login)) where org_id is null;
