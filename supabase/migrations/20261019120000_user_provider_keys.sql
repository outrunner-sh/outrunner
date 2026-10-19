-- A user's own keys for model providers (Settings → Providers): OpenRouter,
-- Anthropic, Z.ai, Moonshot, DeepSeek, and whatever runtime-agent's
-- providers.json lists next. One row per user and provider, so a provider is
-- added without a migration.
--
-- Third-party credentials, so the same treatment as user_credentials: RLS on
-- with no policy and every grant revoked, reached only by the service role
-- through lib/db/credentials.ts. Keys are AES-256-GCM sealed
-- (lib/crypto/secret-box.ts).
--
-- Replaces user_credentials.openrouter_key_*, copied over below and left in
-- place until a later release drops them. Anthropic API keys stored in the
-- Claude slot (user_credentials.anthropic_key_*) move here too, but in the app
-- (lib/providers/claude-slot.ts): sealed, an API key can't be told from a
-- Claude subscription token in SQL.
-- ---------------------------------------------------------------------------

create table if not exists user_provider_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- An id from runtime-agent/internal/claude/providers.json.
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The key, sealed.
  key_ciphertext text not null,
  -- Its last 4 characters, for display without decrypting.
  key_hint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

drop trigger if exists user_provider_keys_set_updated_at on user_provider_keys;
create trigger user_provider_keys_set_updated_at
  before update on user_provider_keys
  for each row execute function set_updated_at();

alter table user_provider_keys enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table user_provider_keys from anon, authenticated;

-- Every saved OpenRouter key, as it is: the ciphertext is copied, never
-- opened. A key already here (from an earlier run, or saved since) is newer
-- and is kept.
insert into user_provider_keys (user_id, provider, key_ciphertext, key_hint, updated_at)
select user_id, 'openrouter', openrouter_key_ciphertext, openrouter_key_hint, coalesce(openrouter_key_updated_at, now())
from user_credentials
where openrouter_key_ciphertext is not null
on conflict (user_id, provider) do nothing;
