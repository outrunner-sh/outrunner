-- SECURITY — pull_requests is written by the server alone.
--
-- pull_requests_owner_all (20260804090000) was `for all`: a signed-in owner
-- could insert or update their session's rows straight through Supabase's
-- REST API, every column, including project_id and github_number, and
-- project_id had no foreign key (20261028170000). Server reads trust these
-- rows (lib/db/github-loop.ts pullForBranch: which pull request a CI failure
-- is for; follow-ups; tracker write-back), so a forged row could steer them
-- to another project's pull request.
--
-- As 20261106100000 did for workspaces: the owner keeps a SELECT policy,
-- insert/update/delete have no policy and are revoked from anon and
-- authenticated, and the server writes with the service role
-- (lib/db/repositories.ts, lib/session/pull-request-*.ts), whose callers
-- have checked the session's owner.
--
-- project_id now references projects. Production had no orphans when this
-- was written (0 of 21 rows); if one appears before it's applied, the
-- migration fails rather than deleting anything.
-- ---------------------------------------------------------------------------

drop policy if exists pull_requests_owner_all on pull_requests;
drop policy if exists pull_requests_owner_read on pull_requests;
create policy pull_requests_owner_read on pull_requests
  for select using (auth.uid() = owner_id);

revoke all on table pull_requests from anon;
revoke insert, update, delete, truncate, references, trigger on table pull_requests from authenticated;
grant select on table pull_requests to authenticated;
grant all on table pull_requests to service_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pull_requests_project_id_fkey') then
    alter table pull_requests
      add constraint pull_requests_project_id_fkey
      foreign key (project_id) references projects (id) on delete cascade;
  end if;
end $$;

create index if not exists pull_requests_project_branch_idx on pull_requests (project_id, head_branch);
