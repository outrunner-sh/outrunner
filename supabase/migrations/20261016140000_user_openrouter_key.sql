-- A user's own OpenRouter key for Outrunner's models (Settings → Providers): when
-- one is saved, their sessions on those models run on it, and OpenRouter bills
-- them, instead of on the server's key and its $5 allowance.
--
-- A third-party credential like the Daytona key and Modal token beside it: in
-- the same service-role-only table (RLS on, no policies), sealed at rest.
-- ---------------------------------------------------------------------------

alter table user_credentials
  -- The key, AES-256-GCM sealed (lib/crypto/secret-box.ts).
  add column if not exists openrouter_key_ciphertext text,
  -- Its last 4 characters, for display without decrypting.
  add column if not exists openrouter_key_hint text,
  add column if not exists openrouter_key_updated_at timestamptz;
