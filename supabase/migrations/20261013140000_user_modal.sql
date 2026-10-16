-- A user's own Modal account for their cloud sessions (Settings → Sandbox):
-- 'modal' joins the sandbox choices, on a Modal token they supply (an id and
-- a secret), so the boxes and their bill are theirs.
--
-- The token is a third-party credential like the Daytona key beside it: in
-- the same service-role-only table (RLS on, no policies), sealed at rest.
-- ---------------------------------------------------------------------------

alter table user_credentials
  -- The token's id and secret as JSON, AES-256-GCM sealed (lib/crypto/secret-box.ts).
  add column if not exists modal_token_ciphertext text,
  -- Last 4 characters of the token id, for display without decrypting.
  add column if not exists modal_token_hint text,
  add column if not exists modal_token_updated_at timestamptz;

alter table user_credentials
  drop constraint if exists user_credentials_sandbox_check;
alter table user_credentials
  add constraint user_credentials_sandbox_check check (sandbox in ('outrunner', 'daytona', 'modal'));
