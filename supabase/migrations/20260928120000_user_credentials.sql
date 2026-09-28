-- Multi-user — per-user credentials.
--
-- Runtime was single-user: one server-wide GITHUB_PAT and one shared Anthropic
-- token served everybody. Opening sign-up to any GitHub account makes that
-- untenable — a shared credential injected into a box where Claude runs with
-- `--permission-mode bypassPermissions` is exfiltratable by whoever holds that
-- box. Each user now supplies their own; this table holds them.
--
-- SECURITY — why this table has no policies:
--
-- `runtime_computers.agent_secret` is guarded only by an owner-scoped RLS
-- policy (`auth.uid() = owner_id`). That makes it readable from the BROWSER:
-- the signed-in user's session carries the public anon key, so a plain
-- `select('agent_secret')` in the console returns it. Owner-scoped is not
-- server-only.
--
-- These are third-party credentials, so they get the stronger treatment: RLS is
-- enabled and NO policy is created, which denies anon and authenticated
-- outright. Only the service role reaches this table, and only through
-- `lib/db/credentials.ts` after the caller's session has been verified. The
-- explicit revoke below is belt-and-braces against a future policy being added
-- by reflex.
--
-- Values are additionally encrypted at rest (AES-256-GCM, see
-- `lib/crypto/secret-box.ts`), so a database dump alone does not yield usable
-- GitHub or Anthropic credentials — the key lives in CREDENTIALS_ENCRYPTION_KEY.
-- ---------------------------------------------------------------------------

create table user_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- GitHub OAuth provider_token, captured at the auth callback. Supabase
  -- surfaces it only in the session immediately after OAuth and never
  -- refreshes it, so we persist it ourselves and re-prompt when it goes stale.
  github_token_ciphertext text,
  -- The login the stored token actually belongs to. Kept in clear for display
  -- and for detecting a token that no longer matches the signed-in account.
  github_token_login text,
  github_token_updated_at timestamptz,

  -- User-supplied ANTHROPIC_API_KEY, injected only into that user's own box.
  anthropic_key_ciphertext text,
  -- Last 4 characters, for "sk-…AbCd" style display without decrypting.
  anthropic_key_hint text,
  anthropic_key_updated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_credentials_set_updated_at
  before update on user_credentials
  for each row execute function set_updated_at();

alter table user_credentials enable row level security;

-- No policy is created on purpose. With RLS enabled and no policy, every
-- anon/authenticated request matches nothing and is denied; the service role
-- bypasses RLS and is the only way in. Do NOT add an owner-scoped policy here
-- "for convenience" — that is exactly what exposes agent_secret today.
revoke all on table user_credentials from anon, authenticated;
