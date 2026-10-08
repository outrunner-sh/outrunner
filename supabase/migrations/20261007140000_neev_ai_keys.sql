-- Neev AI — Claude Code on models Neev serves through OpenRouter, picked per
-- session in the model menu.
--
-- Each user gets their OWN OpenRouter key, created through OpenRouter's
-- management API the first time they pick a Neev AI model, with a spending
-- limit OpenRouter enforces ($5, reset monthly, until there is billing). A
-- shared Neev key would sit in every session's environment, where Claude can
-- read it out; a per-user capped key bounds a leak to that user's limit, and
-- can be disabled on its own.
--
-- The key is a third-party credential like the others here, so it lives in the
-- same service-role-only table (RLS on, no policies) and is encrypted at rest.
-- `if not exists`: an earlier draft of this feature added the same columns.
-- ---------------------------------------------------------------------------

alter table user_credentials
  -- The user's OpenRouter key, AES-256-GCM sealed (lib/crypto/secret-box.ts).
  -- OpenRouter shows the plaintext only once, at creation.
  add column if not exists neev_key_ciphertext text,
  -- OpenRouter's id for the key: how it is read (usage) or disabled later.
  add column if not exists neev_key_hash text,
  add column if not exists neev_key_created_at timestamptz;
