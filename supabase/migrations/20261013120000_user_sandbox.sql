-- Where a user's cloud sessions run, chosen in Settings → Sandbox.
--
-- 'outrunner' (the default) is Outrunner's own sandboxes: the deployment's
-- provider (RUNTIME_PROVIDER, NeevCloud in production). 'daytona' is the user's
-- own Daytona account, on an API key they supply, so the boxes (and their
-- bill) are theirs.
--
-- The key is a third-party credential like the others here, so it lives in the
-- same service-role-only table (RLS on, no policies) and is encrypted at rest.
-- ---------------------------------------------------------------------------

alter table user_credentials
  add column if not exists sandbox text not null default 'outrunner',
  -- The user's Daytona API key, AES-256-GCM sealed (lib/crypto/secret-box.ts).
  add column if not exists daytona_key_ciphertext text,
  -- Last 4 characters, for display without decrypting.
  add column if not exists daytona_key_hint text,
  add column if not exists daytona_key_updated_at timestamptz;

alter table user_credentials
  drop constraint if exists user_credentials_sandbox_check;
alter table user_credentials
  add constraint user_credentials_sandbox_check check (sandbox in ('outrunner', 'daytona'));

-- Which provider made a Runtime Computer ('neev', 'daytona', 'user-daytona'),
-- so a project whose owner moved to another sandbox gets a new computer there,
-- and the old box is deleted, instead of one provider asking after another's
-- sandbox. Null: made before this was recorded, by the deployment's provider.
alter table runtime_computers
  add column if not exists provider text;
