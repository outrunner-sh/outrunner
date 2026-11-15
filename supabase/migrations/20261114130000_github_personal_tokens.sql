-- A user's own GitHub personal access token (Settings → Connections → GitHub):
-- reaches every repository their account can, with no GitHub App installed by
-- an organization owner. Service role only, sealed with CREDENTIALS_ENCRYPTION_KEY.
create table public.user_github_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  token_kind text not null check (token_kind in ('classic', 'fine_grained')),
  -- A classic token's scopes as GitHub reported them; null for fine-grained,
  -- whose permissions GitHub doesn't report.
  scopes text[],
  -- When GitHub says the token expires; null for one that never does.
  expires_at timestamptz,
  token_ciphertext text not null,
  updated_at timestamptz not null default now()
);
alter table public.user_github_tokens enable row level security;
revoke all on public.user_github_tokens from anon, authenticated;
grant all on public.user_github_tokens to service_role;
