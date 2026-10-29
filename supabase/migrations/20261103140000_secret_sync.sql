-- Doppler and Infisical secret sync (docs/secret-sync.md): an org connects
-- either with its credentials (Settings → Org → Integrations), and a project
-- (an `environments` row) is linked to a Doppler config, or an Infisical
-- environment and folder, by one of the org's admins. A new session of a
-- linked project fetches the secrets as it starts (lib/secret-sync), so no
-- copy of a value is kept here: only the credentials, sealed
-- (lib/crypto/secret-box.ts), and each link's last sync, by name.
--
-- Both tables are the server's alone (RLS on, no policy, every grant
-- revoked), reached through lib/db/secret-sync.ts with the service role.
-- ---------------------------------------------------------------------------

create table if not exists org_secret_integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  provider text not null check (provider in ('doppler', 'infisical')),
  -- Doppler {token}; Infisical {clientId, clientSecret}: sealed JSON.
  credentials_ciphertext text not null,
  -- What isn't secret, and what a link falls back to: Doppler {tokenKind,
  -- project, config}; Infisical {siteUrl, projectId, environment}.
  settings jsonb not null default '{}'::jsonb,
  -- What it's connected to, as the provider named it when it was checked
  -- (a Doppler workplace or config, an Infisical site).
  label text not null check (char_length(label) between 1 and 200),
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider)
);

alter table org_secret_integrations enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table org_secret_integrations from anon, authenticated;

-- A project linked to one of its org's integrations, at most one of each
-- provider. Disconnecting the integration unlinks every project from it.
create table if not exists environment_secret_links (
  environment_id uuid not null references environments (id) on delete cascade,
  integration_id uuid not null references org_secret_integrations (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  provider text not null check (provider in ('doppler', 'infisical')),
  -- Where in the provider, over the integration's own: Doppler {project,
  -- config}; Infisical {projectId, environment, path, cli}, `cli` whether
  -- sessions get its CLI signed in (off unless set).
  settings jsonb not null default '{}'::jsonb,
  linked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The last fetch, by a session starting or a test from the page: when,
  -- why it failed or what it couldn't do beside (a sentence, never a
  -- value), the names it brought and the names a session can't take (PATH,
  -- RUNTIME_…).
  last_synced_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_warning text check (last_warning is null or char_length(last_warning) <= 500),
  last_names text[] not null default '{}',
  last_skipped text[] not null default '{}',
  primary key (environment_id, provider)
);

create index if not exists environment_secret_links_integration_idx on environment_secret_links (integration_id);

alter table environment_secret_links enable row level security;
revoke all on table environment_secret_links from anon, authenticated;

-- updated_at moves with each change to the row (set_updated_at), but a
-- link's only with a change to the link itself: a sync's record isn't one.
drop trigger if exists org_secret_integrations_set_updated_at on org_secret_integrations;
create trigger org_secret_integrations_set_updated_at
  before update on org_secret_integrations
  for each row execute function set_updated_at();

drop trigger if exists environment_secret_links_set_updated_at on environment_secret_links;
create trigger environment_secret_links_set_updated_at
  before update of settings, integration_id on environment_secret_links
  for each row execute function set_updated_at();
