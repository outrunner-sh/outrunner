-- GitHub, connected for repository access (Settings → Connections → GitHub),
-- apart from signing in with it.
--
-- Signing in with GitHub used to ask for the `repo` scope and keep the OAuth
-- token it minted (user_credentials.github_token_ciphertext): one token that
-- never expires and reaches every repository the user can, in every GitHub
-- organization they belong to. Sign-in is now identity alone
-- (`read:user user:email`), and a user's own repository access is a user
-- authorization of the Outrunner GitHub App (lib/github/user-auth.ts):
--
-- - its access token (`ghu_`) reaches only what both the user and the App's
--   installations reach (the repositories picked on GitHub, all or selected),
--   with the App's permissions, and expires after 8 hours;
-- - its refresh token (6 months) renews it (lib/github/user-connection.ts).
--   GitHub hands out a new refresh token with each renewal and the old one
--   stops working, so renewals are claimed (refresh_claimed_until) across
--   servers, and saved only over the refresh token they used.
--
-- One row per Outrunner user. Same treatment as user_credentials: RLS on with
-- no policy (service role only, through lib/db/github-connections.ts), and the
-- tokens sealed with CREDENTIALS_ENCRYPTION_KEY (lib/crypto/secret-box.ts).
--
-- The old sign-in tokens stay where they are, as a deprecated fallback
-- (GITHUB_LEGACY_TOKENS), until their users connect or remove them.
-- ---------------------------------------------------------------------------

create table if not exists user_github_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- The GitHub account authorized, by GitHub's numeric id (never reused) and
  -- its login when it was connected (for display).
  github_user_id bigint not null,
  github_login text not null,

  access_token_ciphertext text not null,
  -- Null only where the App's "Expire user authorization tokens" is off.
  access_token_expires_at timestamptz,
  refresh_token_ciphertext text,
  refresh_token_expires_at timestamptz,

  -- A renewal under way on some server, until then: the others wait for it.
  refresh_claimed_until timestamptz,
  -- GitHub refused the refresh token (revoked, expired) or the user revoked
  -- the App's authorization: only connecting again mends it.
  broken_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_github_connections_github_user_id
  on user_github_connections (github_user_id);

drop trigger if exists user_github_connections_set_updated_at on user_github_connections;
create trigger user_github_connections_set_updated_at
  before update on user_github_connections
  for each row execute function set_updated_at();

alter table user_github_connections enable row level security;
-- No policy on purpose (see 20260928120000_user_credentials.sql).
revoke all on table user_github_connections from anon, authenticated;

-- The emails GitHub verified for the user at their last GitHub sign-in, kept
-- instead of the token that read them: invites, join requests and a team
-- org's domain go by them (lib/orgs/verified-emails.ts).
alter table user_credentials
  add column if not exists github_verified_emails jsonb,
  add column if not exists github_verified_emails_at timestamptz;
