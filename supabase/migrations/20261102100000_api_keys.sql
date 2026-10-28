-- The public API (/api/v1, docs/api.md): keys that sign a script, a CI job
-- or an agent in, what each call did, and where a session came from.
--
-- A key is an org's (Settings → Org → API keys, made by an admin) or a
-- person's (Settings → API keys). Either way it acts as the user who made
-- it, with their Roles & access in the org it's used in: an org key only in
-- its org, and only while its maker is still one of its admins; a personal
-- key in any org its maker is a member of. Only the key's sha256 is kept,
-- as cli_tokens keeps tokens: a leaked row signs no one in.
--
-- Both tables are the server's alone (RLS on, no policy, every grant
-- revoked), reached through lib/db/api-keys.ts with the service role.
-- ---------------------------------------------------------------------------

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  -- The org an org key is for; null for a personal key.
  org_id uuid references organizations (id) on delete cascade,
  -- Who made it, and so who it acts as.
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- The key's last four characters, to tell keys apart on the page.
  hint text not null check (hint ~ '^[A-Za-z0-9_-]{4}$'),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists api_keys_org_idx on api_keys (org_id) where org_id is not null;
create index if not exists api_keys_user_idx on api_keys (user_id);

alter table api_keys enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table api_keys from anon, authenticated;

-- One row per call to /api/v1 or /api/mcp: which key (or CLI token), as
-- whom, in which org, and how it was answered. Who did what through the API
-- is read from here; nothing in it is a secret.
create table if not exists api_requests (
  id bigint generated always as identity primary key,
  key_id uuid references api_keys (id) on delete cascade,
  cli_token_id uuid references cli_tokens (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid references organizations (id) on delete cascade,
  method text not null check (char_length(method) between 1 and 10),
  path text not null check (char_length(path) between 1 and 300),
  status smallint not null,
  created_at timestamptz not null default now()
);

create index if not exists api_requests_key_idx on api_requests (key_id, created_at desc);
create index if not exists api_requests_org_idx on api_requests (org_id, created_at desc);

alter table api_requests enable row level security;
revoke all on table api_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Where a session came from, for the API's `source` filter: the app, a Slack
-- thread, an automation, or the API. Sessions from before are read from what
-- they left behind: a thread's link, an automation run.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists source text not null default 'app'
  check (source in ('app', 'slack', 'automation', 'api'));

update workspaces set source = 'slack'
where source = 'app' and slack_thread_url is not null;

update workspaces set source = 'automation'
where source = 'app' and id in (select workspace_id from automation_runs where workspace_id is not null);

create index if not exists workspaces_org_source_idx on workspaces (org_id, source, created_at desc);
