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
  add column if not exists e2b_template_error text,
  -- When a build was claimed: one caller at a time starts a build (the
  -- conditional claim), and a claim whose build never started goes stale.
  add column if not exists e2b_template_started_at timestamptz,
  -- The last template that built ready in their account: new boxes keep
  -- starting from it while a newer one (a box image bump) builds, so
  -- sessions don't stop for the rebuild. Deleted from their E2B once the
  -- newer one is ready.
  add column if not exists e2b_serving_template_id text;

alter table user_credentials
  drop constraint if exists user_credentials_sandbox_check;
alter table user_credentials
  add constraint user_credentials_sandbox_check check (sandbox in ('outrunner', 'daytona', 'modal', 'gcp', 'e2b'));

-- A box in the user's own E2B is theirs, billed to them, so it takes none of
-- their plan's (or org's) box slots, as their own Daytona, Modal and GCP
-- don't. Mirrors isLiveMeteredComputer in lib/billing/limits.ts. Bodies as
-- in 20261104120000_gcp_sandboxes.sql, with 'user-e2b' added.
create or replace function live_metered_computers(for_owner uuid)
returns bigint language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*) from runtime_computers
  where owner_id = for_owner
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal', 'user-gcp', 'user-e2b'))
    and (status = 'ready' or (status = 'provisioning' and updated_at > now() - interval '10 minutes'))
$$;
create or replace function live_org_computers(for_org uuid)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) from runtime_computers
  where org_id = for_org
    and owner_id not in (select user_id from org_connectors where org_id = for_org)
    and (not pooled or warm_expires_at is not null)
    and (provider is null or provider not in ('user-daytona', 'user-modal', 'user-gcp', 'user-e2b'))
    and (status = 'ready' or (status = 'provisioning' and updated_at > now() - interval '10 minutes'))
$$;
revoke all on function live_org_computers(uuid) from public, anon, authenticated;
