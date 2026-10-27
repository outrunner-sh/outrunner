-- Review fix to 20261029100000 (applied): an installation is kept for an org
-- only by the GitHub user who installed it. GitHub's webhook says who that was
-- (the installation event's sender), and installing on an organization needs
-- one of its owners or App managers. So the webhook records each new
-- installation unclaimed, with its installer; the setup route, or the
-- installer from Settings → Org → GitHub, claims it for an org. An admin's
-- Remove unclaims it, for the installer to add back to that org only
-- (removed_from): the installer may have lost their say over the GitHub
-- account since, and only a fresh install, which GitHub lets only its owners
-- make, takes it to another org.
--
-- The installer is matched by GitHub's numeric user id, never by login: a
-- login can be renamed and then taken by someone else. The login is kept for
-- showing.
-- ---------------------------------------------------------------------------

alter table github_installations alter column org_id drop not null;
alter table github_installations add column if not exists installer_id bigint;
alter table github_installations add column if not exists installer_login text;
-- Gone with that org, as with org_id: cleared, it would let the installer
-- take it to any org again.
alter table github_installations add column if not exists removed_from uuid references organizations (id) on delete cascade;

-- An unclaimed installation has its installer to claim it.
alter table github_installations drop constraint if exists github_installations_claimable;
alter table github_installations add constraint github_installations_claimable
  check (org_id is not null or installer_id is not null);

create index if not exists github_installations_installer_idx
  on github_installations (installer_id) where org_id is null;
