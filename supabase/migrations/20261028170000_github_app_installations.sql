-- Code review, step two: the Outrunner GitHub App's installations, each linked
-- to the Outrunner org whose admin installed it from the Automations page.
-- Code review posts as the app, on the repositories an installation covers.
--
-- One GitHub account's installation may serve more than one Outrunner org
-- (someone's personal org and their team's), so a row is an (org,
-- installation) pair. Uninstalling the app on GitHub deletes its rows (the
-- app's `installation` webhook); unlinking in Outrunner deletes one.
--
-- The server's alone (RLS on, no policy, grants revoked), reached through
-- lib/db/github-installations.ts, whose routes check the caller is an admin.
-- ---------------------------------------------------------------------------

create table if not exists github_app_installations (
  org_id uuid not null references organizations (id) on delete cascade,
  installation_id bigint not null check (installation_id > 0),
  -- The GitHub account it's installed on, as GitHub last reported it.
  account_login text not null,
  account_type text not null check (account_type in ('User', 'Organization')),
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  -- Set while the account has suspended the app: nothing is posted then.
  suspended_at timestamptz,
  linked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, installation_id)
);

create index if not exists github_app_installations_installation_idx
  on github_app_installations (installation_id);

alter table github_app_installations enable row level security;
revoke all on table github_app_installations from anon, authenticated;
