-- Webhooks for the public API (docs/api.md): what a session started through
-- the API tells a URL as it goes (workspace.ready, turn.completed,
-- needs_input, pr.opened, error), signed so the receiver knows it's
-- Outrunner's.
--
-- Who signs is who the key acts for: an org key's events with its org's
-- secret, a personal key's (or the CLI's) with its maker's. Each also has an
-- endpoint of its own that hears every event of theirs, besides a
-- `webhook_url` named when a session is made. Secrets are sealed
-- (lib/crypto/secret-box.ts): the database alone signs nothing.
--
-- All three tables are the server's alone (RLS on, no policy, grants
-- revoked), reached through lib/db/api-webhooks.ts with the service role.
-- ---------------------------------------------------------------------------

create table if not exists api_webhook_settings (
  -- An org's (for its org keys) or a user's (for their personal keys).
  scope text not null check (scope in ('org', 'user')),
  scope_id uuid not null,
  -- Hears every event of the scope's sessions; null for none.
  url text check (url is null or (char_length(url) <= 2000 and url ~ '^https://')),
  secret_ciphertext text not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (scope, scope_id)
);

alter table api_webhook_settings enable row level security;
revoke all on table api_webhook_settings from anon, authenticated;

-- A session started through the API, watched for what to tell: its setup's
-- end, each turn's end after a message, a question, a pull request.
create table if not exists api_watches (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Whose secret and endpoint: as api_webhook_settings.
  scope text not null check (scope in ('org', 'user')),
  scope_id uuid not null,
  webhook_url text check (webhook_url is null or (char_length(webhook_url) <= 2000 and webhook_url ~ '^https://')),
  -- A turn's end is awaited (a message was sent), and what's been seen of it.
  awaiting boolean not null default false,
  seen_working boolean not null default false,
  baseline_event text,
  -- Whether the baseline came from the send (its fence, or an empty log for
  -- a first prompt) rather than from where a first look found the log.
  baseline_fenced boolean not null default false,
  -- The question (its tool call) already told as needs_input.
  asked_tool_use text,
  -- Pull requests already told as opened, as "<project id>#<number>".
  told_prs text[] not null default '{}',
  -- The cron's tick keeps looking until then; null once nothing is awaited.
  watch_until timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_watches_due_idx on api_watches (watch_until) where watch_until is not null;

alter table api_watches enable row level security;
revoke all on table api_watches from anon, authenticated;

-- One event to one URL, tried until it's answered 2xx or its tries run out
-- (lib/api/webhooks.ts has the backoff).
create table if not exists api_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('org', 'user')),
  scope_id uuid not null,
  workspace_id uuid references workspaces (id) on delete set null,
  event text not null check (event in ('workspace.ready', 'turn.completed', 'needs_input', 'pr.opened', 'error')),
  url text not null check (char_length(url) <= 2000),
  payload jsonb not null,
  attempts smallint not null default 0,
  -- When it's next tried; null once it was delivered or gave up.
  next_attempt_at timestamptz default now(),
  delivered_at timestamptz,
  last_status smallint,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists api_webhook_deliveries_due_idx on api_webhook_deliveries (next_attempt_at) where next_attempt_at is not null;
create index if not exists api_webhook_deliveries_scope_idx on api_webhook_deliveries (scope, scope_id, created_at desc);

alter table api_webhook_deliveries enable row level security;
revoke all on table api_webhook_deliveries from anon, authenticated;
