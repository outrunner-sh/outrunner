-- Provider ids have separate namespaces. Existing GitHub rows are unchanged.
alter table public.projects alter column github_repo_id drop not null;
alter table public.projects add column gitlab_repo_id bigint;
alter table public.projects add constraint projects_gitlab_repo_unique unique (org_id, gitlab_repo_id);
alter table public.projects add constraint projects_one_code_provider check (
  (github_repo_id is not null and gitlab_repo_id is null)
  or (github_repo_id is null and gitlab_repo_id is not null and gitlab_repo_id > 0 and full_name like 'gitlab.com/%')
);

create table public.user_gitlab_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  gitlab_user_id bigint not null,
  gitlab_login text not null,
  token_ciphertext text not null,
  updated_at timestamptz not null default now()
);
alter table public.user_gitlab_connections enable row level security;
revoke all on public.user_gitlab_connections from anon, authenticated;
grant all on public.user_gitlab_connections to service_role;
