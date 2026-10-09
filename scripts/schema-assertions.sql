-- Schema behaviour assertions. Each block raises an exception on failure, so
-- the script fails loudly under `psql -v ON_ERROR_STOP=1`.

\set QUIET on
set client_min_messages to notice;

insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
       ('22222222-2222-2222-2222-222222222222', 'other@example.com');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('11111111-1111-1111-1111-111111111111', 42,
        'immadsahin/runtime', 'immadsahin', 'runtime');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('22222222-2222-2222-2222-222222222222', 84,
        'other/runtime', 'other', 'runtime');

-- 1. A repo may be synced only once per owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 42,
          'immadsahin/runtime', 'immadsahin', 'runtime');
  raise exception 'FAIL: duplicate (owner, repo) was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate repo rejected';
end $$;

-- 2. A workspace cannot reference a project belonging to another owner.
do $$
declare other_project_id uuid;
begin
  select id into other_project_id from projects where owner_id = '22222222-2222-2222-2222-222222222222';
  insert into workspaces (owner_id, project_id, branch)
  values ('11111111-1111-1111-1111-111111111111', other_project_id, 'cross-owner');
  raise exception 'FAIL: workspace accepted another owner''s project';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner project rejected';
end $$;

-- 3. Only one live workspace per (project, branch).
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;
  raise exception 'FAIL: second live workspace on same branch was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate live branch rejected';
end $$;

-- 4. Destroying a workspace frees the branch for reuse.
update workspaces set status = 'destroyed' where branch = 'feat/x';
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

-- 5. Lifecycle actions use explicit in-progress enum values.
do $$
begin
  update workspaces set status = 'suspending'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'destroying'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'creating'
  where branch = 'feat/x' and status <> 'destroyed';
  raise notice 'ok: lifecycle transition states accepted';
end $$;

-- 6. At most one queued/running job per workspace.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'first', 'running'
from workspaces where status <> 'destroyed' limit 1;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, status)
  select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: concurrent job in one workspace was allowed';
exception when unique_violation then
  raise notice 'ok: concurrent job rejected';
end $$;

-- 7. A finished job frees the slot.
update jobs set status = 'succeeded' where prompt = 'first';

-- 7a. Jobs default to Claude for backwards compatibility and accept Codex.
do $$
declare agent_name text;
begin
  insert into jobs (owner_id, workspace_id, prompt)
  select '11111111-1111-1111-1111-111111111111', id, 'default agent'
  from workspaces where status <> 'destroyed' limit 1
  returning agent into agent_name;
  if agent_name <> 'claude' then
    raise exception 'FAIL: job agent did not default to Claude';
  end if;
  update jobs set status = 'succeeded' where prompt = 'default agent';
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'codex agent', 'codex'
  from workspaces where status <> 'destroyed' limit 1;
  update jobs set status = 'succeeded' where prompt = 'codex agent';
  raise notice 'ok: job agent values accepted';
end $$;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'invalid agent', 'unknown'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: invalid job agent was allowed';
exception when check_violation then
  raise notice 'ok: invalid job agent rejected';
end $$;

-- 8. A job cannot reference a workspace belonging to another owner.
do $$
declare owner_workspace_id uuid;
begin
  select id into owner_workspace_id from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into jobs (owner_id, workspace_id, prompt)
  values ('22222222-2222-2222-2222-222222222222', owner_workspace_id, 'cross-owner');
  raise exception 'FAIL: job accepted another owner''s workspace';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner workspace rejected';
end $$;

-- 9. A finished job leaves room for the next queued job.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
from workspaces where status <> 'destroyed' limit 1;

-- 10. updated_at is maintained by trigger.
do $$
declare touched boolean;
begin
  update jobs set status = 'running' where prompt = 'second';
  select updated_at > created_at into touched from jobs where prompt = 'second';
  if not touched then
    raise exception 'FAIL: updated_at trigger did not fire';
  end if;
  raise notice 'ok: updated_at trigger fires';
end $$;

-- 11. Pull requests are owner-scoped and one-to-one with a workspace.
insert into pull_requests (
  owner_id, workspace_id, github_number, url, title, base_branch, head_branch
)
select
  '11111111-1111-1111-1111-111111111111', id, 7,
  'https://github.com/immadsahin/runtime/pull/7', 'Runtime test', 'main', 'feat/x'
from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;

do $$
declare workspace uuid;
begin
  select id into workspace from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into pull_requests (
    owner_id, workspace_id, github_number, url, title, base_branch, head_branch
  ) values (
    '11111111-1111-1111-1111-111111111111', workspace, 8,
    'https://github.com/immadsahin/runtime/pull/8', 'Duplicate', 'main', 'feat/x'
  );
  raise exception 'FAIL: duplicate workspace pull request was allowed';
exception when unique_violation then
  raise notice 'ok: one pull request per workspace enforced';
end $$;

-- 12. RLS isolates rows by owner.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authed') then
    create role authed nologin;
  end if;
  grant usage on schema public to authed;
  grant all on all tables in schema public to authed;
end $do$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  select count(*) into n from projects where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % project rows to another user', n;
  end if;
  select count(*) into n from workspaces where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % workspace rows', n;
  end if;
  select count(*) into n from jobs where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % job rows', n;
  end if;
  select count(*) into n from pull_requests where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % pull request rows', n;
  end if;
  raise notice 'ok: RLS hides other owners'' rows';
end $$;

-- 13. RLS rejects inserts that forge another owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 99, 'x/y', 'x', 'y');
  raise exception 'FAIL: forged owner_id insert was allowed';
exception when insufficient_privilege then
  raise notice 'ok: forged owner_id insert rejected';
end $$;

reset role;

-- 14. Every account gets one personal team, which it owns.
do $$
declare
  n integer;
  r team_role;
begin
  select count(*) into n from teams
  where personal and created_by = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then
    raise exception 'FAIL: % personal teams for a new account', n;
  end if;
  select m.role into r
  from team_members m join teams t on t.id = m.team_id
  where t.personal and t.created_by = '11111111-1111-1111-1111-111111111111'
    and m.user_id = '11111111-1111-1111-1111-111111111111';
  if r is distinct from 'owner' then
    raise exception 'FAIL: the account is % of its personal team', r;
  end if;
  raise notice 'ok: a new account owns one personal team';
end $$;

-- 15. A project synced without a team lands in its owner's personal team.
do $$
begin
  if not exists (
    select 1 from projects p join teams t on t.id = p.team_id
    where p.github_repo_id = 42 and t.personal
      and t.created_by = '11111111-1111-1111-1111-111111111111'
  ) then
    raise exception 'FAIL: a project without a team was not put in its owner''s personal team';
  end if;
  raise notice 'ok: projects default to the owner''s personal team';
end $$;

-- 16. No one else joins a personal team.
do $$
begin
  insert into team_members (team_id, user_id, role)
  select id, '22222222-2222-2222-2222-222222222222', 'member' from teams
  where personal and created_by = '11111111-1111-1111-1111-111111111111';
  raise exception 'FAIL: someone else joined a personal team';
exception when check_violation then
  raise notice 'ok: a personal team has only its own user';
end $$;

-- A shared team: user 1 owns it, user 2 is a member.
insert into teams (id, name, created_by)
values ('33333333-3333-3333-3333-333333333333', 'Acme', '11111111-1111-1111-1111-111111111111');
insert into team_members (team_id, user_id, role)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'owner'),
       ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'member');
do $$ begin
  perform set_config('test.personal_1', id::text, false) from teams
  where personal and created_by = '11111111-1111-1111-1111-111111111111';
end $$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 17. A user sees their own teams and their members, no one else's.
do $$
declare n integer;
begin
  select count(*) into n from teams;
  if n <> 2 then
    raise exception 'FAIL: user 2 sees % teams, not their personal one and Acme', n;
  end if;
  select count(*) into n from teams where id = current_setting('test.personal_1')::uuid;
  if n <> 0 then
    raise exception 'FAIL: RLS leaked another user''s personal team';
  end if;
  select count(*) into n from team_members where team_id = '33333333-3333-3333-3333-333333333333';
  if n <> 2 then
    raise exception 'FAIL: a member sees % of the team''s 2 members', n;
  end if;
  select count(*) into n from team_members where team_id = current_setting('test.personal_1')::uuid;
  if n <> 0 then
    raise exception 'FAIL: RLS leaked another team''s members';
  end if;
  raise notice 'ok: teams and members are visible to members only';
end $$;

-- 18. Teams and memberships change through the server only.
do $$
begin
  insert into teams (name) values ('Mine');
  raise exception 'FAIL: a user created a team directly';
exception when insufficient_privilege then
  raise notice 'ok: users can''t create teams directly';
end $$;

do $$
begin
  update team_members set role = 'owner'
  where team_id = '33333333-3333-3333-3333-333333333333'
    and user_id = '22222222-2222-2222-2222-222222222222';
  if found then
    raise exception 'FAIL: a member promoted themselves';
  end if;
  raise notice 'ok: members can''t change their role';
end $$;

-- 19. A project goes only into a team its owner runs: not someone else's,
-- and not one they are only a member of.
do $$
begin
  insert into projects (owner_id, team_id, github_repo_id, full_name, owner, name)
  values ('22222222-2222-2222-2222-222222222222', current_setting('test.personal_1')::uuid,
          7, 'a/b', 'a', 'b');
  raise exception 'FAIL: a project was put in another user''s team';
exception when insufficient_privilege then
  raise notice 'ok: a project can''t be put in another user''s team';
end $$;

do $$
begin
  insert into projects (owner_id, team_id, github_repo_id, full_name, owner, name)
  values ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
          8, 'a/c', 'a', 'c');
  raise exception 'FAIL: a member added a project to the team';
exception when insufficient_privilege then
  raise notice 'ok: a member can''t add a team''s projects';
end $$;

reset role;

update team_members set role = 'admin'
where team_id = '33333333-3333-3333-3333-333333333333'
  and user_id = '22222222-2222-2222-2222-222222222222';

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
begin
  insert into projects (owner_id, team_id, github_repo_id, full_name, owner, name)
  values ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
          9, 'a/d', 'a', 'd');
  raise notice 'ok: an admin adds a project to the team';
end $$;

reset role;

-- 20. Deleting an account deletes its personal team and what is in it.
insert into auth.users (id, email)
values ('44444444-4444-4444-4444-444444444444', 'gone@example.com');
insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('44444444-4444-4444-4444-444444444444', 10, 'g/h', 'g', 'h');
delete from auth.users where id = '44444444-4444-4444-4444-444444444444';

do $$
declare n integer;
begin
  select count(*) into n from teams where name = 'Personal' and created_by is null;
  if n <> 0 then
    raise exception 'FAIL: % personal teams outlived their account', n;
  end if;
  select count(*) into n from projects where github_repo_id = 10;
  if n <> 0 then
    raise exception 'FAIL: a deleted account''s project survived';
  end if;
  raise notice 'ok: an account''s personal team goes with it';
end $$;
