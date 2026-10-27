-- A session of several repositories (20261028160000) opens a pull request in
-- each one it changed: a pull request is a session's in one repository,
-- project_id, and a session keeps one a repository rather than one in all.
-- A session of one repository has its one, as before (project_id: its own).
-- ---------------------------------------------------------------------------

alter table pull_requests add column if not exists project_id uuid;

update pull_requests pr
set project_id = w.project_id
from workspaces w
where w.id = pr.workspace_id and pr.project_id is null;

-- Given none (a deploy from before this), the session's own repository.
create or replace function pull_requests_default_project()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.project_id is null then
    select project_id into new.project_id from workspaces where id = new.workspace_id;
  end if;
  return new;
end;
$$;

drop trigger if exists pull_requests_default_project on pull_requests;
create trigger pull_requests_default_project
  before insert on pull_requests
  for each row execute function pull_requests_default_project();

alter table pull_requests alter column project_id set not null;

alter table pull_requests drop constraint if exists pull_requests_one_per_workspace;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pull_requests_one_per_repo') then
    alter table pull_requests add constraint pull_requests_one_per_repo unique (workspace_id, project_id);
  end if;
end $$;
