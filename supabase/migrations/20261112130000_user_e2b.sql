-- A user's own E2B for their cloud sessions (Settings → Sandbox): 'e2b' joins
-- the sandbox choices, on an E2B API key they supply, at E2B's cloud or at a
-- self-hosted E2B's URLs, so the boxes and their bill are theirs.
--
-- The key is a third-party credential like the Daytona key beside it: in the
-- same service-role-only table (RLS on, no policies), sealed at rest. The
-- URLs and the template built in their account aren't secret.
-- ---------------------------------------------------------------------------

alter table user_credentials
  -- The E2B API key, AES-256-GCM sealed (lib/crypto/secret-box.ts).
  add column if not exists e2b_key_ciphertext text,
  -- Last 4 characters of the key, for display without decrypting.
  add column if not exists e2b_key_hint text,
  add column if not exists e2b_key_updated_at timestamptz,
  -- A self-hosted E2B's API and client-proxy; both null for E2B's cloud.
  add column if not exists e2b_api_url text,
  add column if not exists e2b_sandbox_url text,
  -- Outrunner's box template, built in their account when they connect: its
  -- build, the image tag it was built at, and where the build is.
  add column if not exists e2b_template_id text,
  add column if not exists e2b_template_build_id text,
  add column if not exists e2b_template_tag text,
  add column if not exists e2b_template_state text
    check (e2b_template_state in ('building', 'ready', 'failed')),
  add column if not exists e2b_template_error text;

alter table user_credentials
  drop constraint if exists user_credentials_sandbox_check;
alter table user_credentials
  add constraint user_credentials_sandbox_check check (sandbox in ('outrunner', 'daytona', 'modal', 'gcp', 'e2b'));
