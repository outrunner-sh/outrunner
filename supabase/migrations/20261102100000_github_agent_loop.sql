-- The GitHub agent loop (Replicas' way): `@outrunner` on an issue or a pull
-- request steers the session working on it, or starts one, as the member
-- who commented; closing it archives that session (lib/github/loop.ts).
--
-- The server's alone (service role), like the automations' runs.
-- ---------------------------------------------------------------------------

-- What the webhook has acted on, by what it was for (a comment's id, a
-- close's time): GitHub redelivers, and a redelivery acts on nothing twice.
-- Claimed before acting, and given back if nothing was done.
create table if not exists github_loop_claims (
  key text primary key,
  created_at timestamptz not null default now()
);

alter table github_loop_claims enable row level security;
revoke all on table github_loop_claims from anon, authenticated;

-- The sessions a mention started, by the issue or pull request they work
-- on: an issue's is found again by this alone; a pull request's also by its
-- head branch and its pull_requests row.
create table if not exists github_session_links (
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('issue', 'pull')),
  number integer not null check (number > 0),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, kind, number, workspace_id)
);

create index if not exists github_session_links_workspace_idx on github_session_links (workspace_id);

alter table github_session_links enable row level security;
revoke all on table github_session_links from anon, authenticated;

-- A pull request's sessions are looked up by its number in its repository.
create index if not exists pull_requests_project_number_idx on pull_requests (project_id, github_number);

-- The member of an org a GitHub account is: the user whose GitHub identity
-- it is, by GitHub's numeric id (a login can be renamed and taken by
-- another), if they're in the org. plpgsql, so the body is read when it's
-- called: auth.identities is Supabase's.
create or replace function github_member(github_user_id bigint, target_org uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  found uuid;
begin
  select i.user_id into found
  from auth.identities i
  join public.organization_members m on m.user_id = i.user_id and m.org_id = target_org
  where i.provider = 'github' and i.provider_id = github_user_id::text
  limit 1;
  return found;
end;
$$;

revoke all on function github_member(bigint, uuid) from public, anon, authenticated;
grant execute on function github_member(bigint, uuid) to service_role;

-- Whether a team org's sessions are archived when the issue or pull request
-- they work on closes (Settings → Org → Defaults). On unless an admin turns
-- it off; a personal org, which has no row, always does.
alter table organization_settings add column if not exists archive_on_close boolean not null default true;
