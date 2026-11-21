-- Several Claude subscriptions per person (Settings → Claude subscription):
-- each a `claude setup-token` the person pasted under a label of their own.
-- A session starts on the first, in the person's order, that isn't at its
-- usage limit (lib/claude/accounts.ts). user_credentials.anthropic_key_*
-- keeps holding the first one, so what reads that slot (the workspace gate,
-- the desktop app, `outrunner claude`) works as before.
--
-- A person's own accounts, never an org's: an org shares API keys, not
-- subscriptions (org_provider_keys).
--
-- Third-party credentials, so the same treatment as user_provider_keys: RLS
-- on with no policy and every grant revoked, reached only by the service role.
-- Tokens are AES-256-GCM sealed (lib/crypto/secret-box.ts).
-- ---------------------------------------------------------------------------

create table if not exists claude_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The person's name for it ("work", "personal"); unique per person, any case.
  label text not null check (char_length(label) between 1 and 32 and label = btrim(label)),
  -- The token, sealed.
  token_ciphertext text not null,
  -- Its last 4 characters, for display without decrypting.
  token_hint text,
  -- The person's order: a session starts on the lowest that can run.
  position integer not null default 0 check (position >= 0),
  -- Set when Claude Code reports this account's usage limit: skipped until then.
  limited_until timestamptz,
  -- Set when Anthropic rejects the token: skipped until it's pasted again.
  needs_reconnect boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists claude_accounts_user_label
  on claude_accounts (user_id, lower(label));
create index if not exists claude_accounts_user_position
  on claude_accounts (user_id, position);

drop trigger if exists claude_accounts_set_updated_at on claude_accounts;
create trigger claude_accounts_set_updated_at
  before update on claude_accounts
  for each row execute function set_updated_at();

alter table claude_accounts enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table claude_accounts from anon, authenticated;
