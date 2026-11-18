-- Secrets beyond a project's (lib/db/scoped-secrets.ts): an org's, which
-- every member's sessions in it get, and a person's own, which their
-- sessions get in any org. Each is limited to some repositories (`repos`,
-- their full names) or none for all. A session gets them under its
-- project's variables and over nothing: team, then project, then personal,
-- then what it was started with, the later winning on a name
-- (lib/runtime/session-setup.deps.ts). Values are sealed
-- (lib/crypto/secret-box.ts) and never read back out.
create table if not exists org_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  value_ciphertext text not null,
  type text not null default 'runtime_secret' check (type in ('runtime_secret', 'environment_variable')),
  repos text[] not null default '{}' check (cardinality(repos) <= 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists user_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  value_ciphertext text not null,
  type text not null default 'runtime_secret' check (type in ('runtime_secret', 'environment_variable')),
  repos text[] not null default '{}' check (cardinality(repos) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

drop trigger if exists org_secrets_set_updated_at on org_secrets;
create trigger org_secrets_set_updated_at
  before update on org_secrets
  for each row execute function set_updated_at();

drop trigger if exists user_secrets_set_updated_at on user_secrets;
create trigger user_secrets_set_updated_at
  before update on user_secrets
  for each row execute function set_updated_at();

alter table org_secrets enable row level security;
alter table user_secrets enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql. The server
-- alone reads and writes them, for the org's admins (an org's) and the
-- person (their own).
