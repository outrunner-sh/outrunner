-- A session of a project with several repositories (up to five,
-- environment_repos) works in a folder of checkouts, one a repository
-- (runtime-agent checkouts.go). The session keeps which: its repositories as
-- they were when it started, [{projectId, fullName, checkout, baseBranch}],
-- so a later change to the project doesn't change a session's. Null for a
-- session of one repository, as every session before was.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists checkouts jsonb
    check (checkouts is null or (jsonb_typeof(checkouts) = 'array' and jsonb_array_length(checkouts) between 2 and 5));
