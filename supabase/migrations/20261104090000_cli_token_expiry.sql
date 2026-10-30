-- CLI tokens expire (lib/db/cli-tokens.ts).
--
-- A token lived until its user logged out (revoked_at), and no longer: a
-- token leaked from a dev machine's config file would work indefinitely.
-- Like an API key's optional expiry, one now lasts a year from when it was
-- made — the CLI signs in again after that (lib/auth/cli-login.ts).
-- Tokens made before this get their year from the day it runs; the last
-- used time (last_used_at) still says which are in use, and settings can
-- show what's coming.

alter table cli_tokens
  add column if not exists expires_at timestamptz not null default (now() + interval '365 days');

create index if not exists cli_tokens_expires_idx on cli_tokens (expires_at);
