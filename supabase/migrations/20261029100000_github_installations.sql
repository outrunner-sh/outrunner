-- Orgs, step six: the Outrunner GitHub App's installations. An org's admin
-- installs the App on a GitHub account or organization; the installation is
-- that org's from then on (one org each), and Outrunner reaches its
-- repositories with tokens of the App's (lib/github/app.ts).
--
-- The server's alone, like the org tables before it: lib/db/github-installations.ts.
-- ---------------------------------------------------------------------------

create table if not exists github_installations (
  -- GitHub's id for the installation.
  installation_id bigint primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  account_login text not null check (char_length(account_login) between 1 and 100),
  account_type text not null check (account_type in ('User', 'Organization')),
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  installed_by uuid references auth.users (id) on delete set null,
  -- Set while GitHub has it suspended (its account's owner, or GitHub).
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists github_installations_org_idx on github_installations (org_id);

drop trigger if exists github_installations_set_updated_at on github_installations;
create trigger github_installations_set_updated_at
  before update on github_installations
  for each row execute function set_updated_at();

alter table github_installations enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table github_installations from anon, authenticated;
