-- Signing in from the terminal (`outrunner login`). The CLI opens
-- /cli-login in the browser; the signed-in user approves it there, and the
-- page hands the CLI a one-time code on 127.0.0.1. The CLI trades that code,
-- with the verifier only it holds (PKCE), for a token it keeps.
--
-- Only hashes are stored: a leaked row signs no one in. Both tables are the
-- same treatment as user_credentials: RLS on with no policy and every grant
-- revoked, reached only by the service role through lib/db/cli-tokens.ts.
-- ---------------------------------------------------------------------------

create table if not exists cli_login_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- base64url(sha256(verifier)), as the CLI sent it.
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  device_name text not null check (char_length(device_name) between 1 and 64),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists cli_login_codes_expires_idx on cli_login_codes (expires_at);

alter table cli_login_codes enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table cli_login_codes from anon, authenticated;

create table if not exists cli_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  device_name text not null check (char_length(device_name) between 1 and 64),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists cli_tokens_user_idx on cli_tokens (user_id);

alter table cli_tokens enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table cli_tokens from anon, authenticated;
