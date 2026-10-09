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

-- 1. A repo may be synced only once per team (here, a personal one).
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 42,
          'immadsahin/runtime', 'immadsahin', 'runtime');
  raise exception 'FAIL: duplicate (owner, repo) was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate repo rejected';
end $$;

-- 2. A workspace's project must exist. (Who may start a session on which
-- project is RLS's to decide: see the team assertions below.)
do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  values ('11111111-1111-1111-1111-111111111111', gen_random_uuid(), 'no-project');
  raise exception 'FAIL: workspace accepted a project that doesn''t exist';
exception when foreign_key_violation then
  raise notice 'ok: a session needs a real project';
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

-- --- Team access (20261009140000_team_access.sql) ---------------------------
-- Acme (3333): user 1 owns it, user 2 is an admin (from 19). Add a member (5),
-- a viewer (6) and someone outside it (7).
insert into auth.users (id, email)
values ('55555555-5555-5555-5555-555555555555', 'member@example.com'),
       ('66666666-6666-6666-6666-666666666666', 'viewer@example.com'),
       ('77777777-7777-7777-7777-777777777777', 'outsider@example.com');
insert into team_members (team_id, user_id, role)
values ('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'member'),
       ('33333333-3333-3333-3333-333333333333', '66666666-6666-6666-6666-666666666666', 'viewer');
insert into user_profiles (user_id, github_login)
values ('55555555-5555-5555-5555-555555555555', 'member-gh'),
       ('77777777-7777-7777-7777-777777777777', 'outsider-gh');
do $$ begin
  perform set_config('test.acme_project', id::text, false) from projects
  where team_id = '33333333-3333-3333-3333-333333333333' and github_repo_id = 9;
end $$;
-- Signed-in users call auth.uid() in Supabase; claim_runtime_computer runs as
-- the caller, so the stand-in role needs that too.
grant usage on schema auth to authed;

set role authed;

-- 21. A team's members see its projects; no one else does.
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
do $$
begin
  if not exists (select 1 from projects where id = current_setting('test.acme_project')::uuid) then
    raise exception 'FAIL: a viewer can''t see the team''s project';
  end if;
  raise notice 'ok: members see their team''s projects';
end $$;
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
do $$
begin
  if exists (select 1 from projects where id = current_setting('test.acme_project')::uuid) then
    raise exception 'FAIL: an outsider sees a team''s project';
  end if;
  raise notice 'ok: outsiders don''t';
end $$;

-- 22. Members start sessions on a team's project; viewers and outsiders can't.
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
insert into workspaces (owner_id, project_id, branch)
values ('55555555-5555-5555-5555-555555555555', current_setting('test.acme_project')::uuid, 'member-session');

set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  values ('66666666-6666-6666-6666-666666666666', current_setting('test.acme_project')::uuid, 'viewer-session');
  raise exception 'FAIL: a viewer started a session';
exception when insufficient_privilege then
  raise notice 'ok: members start sessions, viewers can''t';
end $$;
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  values ('77777777-7777-7777-7777-777777777777', current_setting('test.acme_project')::uuid, 'outsider-session');
  raise exception 'FAIL: an outsider started a session on a team''s project';
exception when insufficient_privilege then
  raise notice 'ok: outsiders can''t start one';
end $$;

-- 23. Teammates see each other's sessions; outsiders don't.
do $$
begin
  if exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: an outsider sees a team''s session';
  end if;
end $$;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
do $$
begin
  if not exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: a viewer can''t see a teammate''s session';
  end if;
  raise notice 'ok: teammates see each other''s sessions';
end $$;

-- 24. A session is changed by its creator or the team's owners and admins,
-- and keeps its creator.
do $$
begin
  update workspaces set status = 'suspended' where branch = 'member-session';
  if found then
    raise exception 'FAIL: a viewer changed a teammate''s session';
  end if;
end $$;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  update workspaces set status = 'suspended' where branch = 'member-session';
  if not found then
    raise exception 'FAIL: an admin couldn''t stop a member''s session';
  end if;
  update workspaces set owner_id = '22222222-2222-2222-2222-222222222222' where branch = 'member-session';
  raise exception 'FAIL: a session''s creator was changed';
exception when check_violation then
  raise notice 'ok: creators and managers change a session, which keeps its creator';
end $$;

-- 25. Each member runs on a computer of their own, which no one else reads.
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$
declare r record;
begin
  select * into r from claim_runtime_computer(current_setting('test.acme_project')::uuid, 'member-secret');
  if not r.should_provision then
    raise exception 'FAIL: a member''s first claim didn''t provision';
  end if;
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  r record;
  n integer;
begin
  select * into r from claim_runtime_computer(current_setting('test.acme_project')::uuid, 'owner-secret');
  if not r.should_provision then
    raise exception 'FAIL: the owner was handed the member''s computer';
  end if;
  select count(*) into n from runtime_computers where project_id = current_setting('test.acme_project')::uuid;
  if n <> 1 then
    raise exception 'FAIL: the owner sees % computers on the project, not just their own', n;
  end if;
  raise notice 'ok: one computer per member, readable by its owner only';
end $$;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
do $$
begin
  perform claim_runtime_computer(current_setting('test.acme_project')::uuid, 'viewer-secret');
  raise exception 'FAIL: a viewer got a computer';
exception when raise_exception then
  raise notice 'ok: viewers get no computer';
end $$;

-- 26. Teammates see each other's profiles; no one else's.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare n integer;
begin
  select count(*) into n from user_profiles where github_login = 'member-gh';
  if n <> 1 then
    raise exception 'FAIL: a teammate''s profile is hidden';
  end if;
  select count(*) into n from user_profiles where github_login = 'outsider-gh';
  if n <> 0 then
    raise exception 'FAIL: an outsider''s profile leaked';
  end if;
  raise notice 'ok: profiles are visible to teammates only';
end $$;

-- 27. Renaming and inviting are for owners and admins; admins invite members
-- and viewers, owners invite admins too; nobody is invited as owner or into a
-- personal team.
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$
begin
  perform rename_team('33333333-3333-3333-3333-333333333333', 'Mine now');
  raise exception 'FAIL: a member renamed the team';
exception when insufficient_privilege then
  raise notice 'ok: members can''t rename';
end $$;
do $$
begin
  perform create_team_invite('33333333-3333-3333-3333-333333333333', 'member', repeat('m', 40));
  raise exception 'FAIL: a member invited someone';
exception when insufficient_privilege then
  raise notice 'ok: members can''t invite';
end $$;

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
-- (A block that catches an error rolls back what it did, so what must stick
-- runs in a block of its own.)
do $$
begin
  perform rename_team('33333333-3333-3333-3333-333333333333', 'Acme Inc');
  perform create_team_invite('33333333-3333-3333-3333-333333333333', 'member', repeat('a', 40));
  perform create_team_invite('33333333-3333-3333-3333-333333333333', 'viewer', repeat('v', 40));
end $$;
do $$
begin
  perform create_team_invite('33333333-3333-3333-3333-333333333333', 'admin', repeat('x', 40));
  raise exception 'FAIL: an admin invited an admin';
exception when insufficient_privilege then
  raise notice 'ok: admins rename and invite members and viewers, not admins';
end $$;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  perform create_team_invite('33333333-3333-3333-3333-333333333333', 'admin', repeat('b', 40));
  begin
    perform create_team_invite('33333333-3333-3333-3333-333333333333', 'owner', repeat('o', 40));
    raise exception 'FAIL: an owner invite was made';
  exception when check_violation then null;
  end;
  begin
    perform create_team_invite(current_setting('test.personal_1')::uuid, 'member', repeat('p', 40));
    raise exception 'FAIL: someone was invited into a personal team';
  exception when check_violation then null;
  end;
  begin
    perform create_team_invite('33333333-3333-3333-3333-333333333333', 'member', 'short');
    raise exception 'FAIL: a guessable invite token was accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok: owners invite admins; no owner, personal or short-token invites';
end $$;

-- 28. An invite says what it's for, joins once, and not when expired or revoked.
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
do $$
declare
  r record;
  team uuid;
begin
  select * into r from team_invite_preview(repeat('a', 40));
  if r.team_name is distinct from 'Acme Inc' or r.invite_role is distinct from 'member' then
    raise exception 'FAIL: the preview said % / %', r.team_name, r.invite_role;
  end if;
  team := accept_team_invite(repeat('a', 40));
  if team <> '33333333-3333-3333-3333-333333333333' or not is_team_member(team) then
    raise exception 'FAIL: accepting didn''t join the team';
  end if;
  if (select role from team_members where team_id = team and user_id = auth.uid()) <> 'member' then
    raise exception 'FAIL: joined with the wrong role';
  end if;
  if exists (select 1 from team_invite_preview(repeat('a', 40))) then
    raise exception 'FAIL: a used invite still previews';
  end if;
  raise notice 'ok: an invite previews, then joins with its role';
end $$;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
begin
  perform accept_team_invite(repeat('a', 40));
  raise exception 'FAIL: a used invite joined someone else';
exception when no_data_found then
  raise notice 'ok: an invite joins once';
end $$;
do $$
begin
  perform accept_team_invite(repeat('z', 40));
  raise exception 'FAIL: a made-up token joined a team';
exception when no_data_found then
  raise notice 'ok: an unknown token joins nothing';
end $$;

reset role;
update team_invites set expires_at = now() - interval '1 minute' where token_hash = sha256(convert_to(repeat('v', 40), 'UTF8'));
set role authed;
do $$
begin
  perform accept_team_invite(repeat('v', 40));
  raise exception 'FAIL: an expired invite joined';
exception when no_data_found then
  raise notice 'ok: an expired invite doesn''t join';
end $$;

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare invite uuid;
begin
  invite := create_team_invite('33333333-3333-3333-3333-333333333333', 'viewer', repeat('r', 40));
  perform revoke_team_invite(invite);
  if exists (select 1 from team_invite_preview(repeat('r', 40))) then
    raise exception 'FAIL: a revoked invite still previews';
  end if;
  raise notice 'ok: a revoked invite is dead';
end $$;

-- 29. Invites are visible to the team's owners and admins only.
do $$
begin
  if not exists (select 1 from team_invites where team_id = '33333333-3333-3333-3333-333333333333') then
    raise exception 'FAIL: an admin can''t list invites';
  end if;
end $$;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$
begin
  if exists (select 1 from team_invites) then
    raise exception 'FAIL: a member sees invites';
  end if;
  raise notice 'ok: invites are for owners and admins';
end $$;

-- 30. Owners change roles, and a team always keeps an owner.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  perform set_team_member_role('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'admin');
  raise exception 'FAIL: an admin changed a role';
exception when insufficient_privilege then
  raise notice 'ok: only owners change roles';
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  perform set_team_member_role('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'admin');
  raise exception 'FAIL: the last owner stepped down';
exception when check_violation then
  raise notice 'ok: the last owner can''t step down';
end $$;
do $$
begin
  perform set_team_member_role('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'owner');
  perform set_team_member_role('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'admin');
  raise notice 'ok: an owner hands over, then steps down';
end $$;

-- 31. Removing: owners remove anyone, admins members and viewers, anyone
-- leaves, and the last owner stays.
-- Now user 2 owns Acme; user 1 is an admin.
do $$
begin
  perform remove_team_member('33333333-3333-3333-3333-333333333333', '66666666-6666-6666-6666-666666666666');
  begin
    perform remove_team_member('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL: an admin removed an owner';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: admins remove viewers, not owners';
end $$;
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
do $$
begin
  perform remove_team_member('33333333-3333-3333-3333-333333333333', '77777777-7777-7777-7777-777777777777');
  if is_team_member('33333333-3333-3333-3333-333333333333') then
    raise exception 'FAIL: leaving didn''t';
  end if;
  raise notice 'ok: members leave';
end $$;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  perform remove_team_member('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222');
  raise exception 'FAIL: the last owner left';
exception when check_violation then
  raise notice 'ok: the last owner can''t leave';
end $$;

-- 32. Anyone creates a team, which they own; only an owner deletes one, never
-- a personal team, and its projects and sessions go with it.
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
do $$
declare team uuid;
begin
  team := create_team('  Side project  ');
  if (select name from teams where id = team) <> 'Side project' then
    raise exception 'FAIL: the name wasn''t trimmed';
  end if;
  if not has_team_role(team, array['owner']::team_role[]) then
    raise exception 'FAIL: the creator doesn''t own the team';
  end if;
  begin
    perform delete_team((select id from teams where personal and created_by = auth.uid()));
    raise exception 'FAIL: a personal team was deleted';
  exception when check_violation then null;
  end;
  raise notice 'ok: anyone creates a team they own; personal teams stay';
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  perform delete_team('33333333-3333-3333-3333-333333333333');
  raise exception 'FAIL: an admin deleted the team';
exception when insufficient_privilege then
  raise notice 'ok: admins don''t delete teams';
end $$;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  perform delete_team('33333333-3333-3333-3333-333333333333');
end $$;
reset role;
do $$
begin
  if exists (select 1 from teams where id = '33333333-3333-3333-3333-333333333333')
     or exists (select 1 from projects where id = current_setting('test.acme_project')::uuid)
     or exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: a deleted team left rows behind';
  end if;
  raise notice 'ok: an owner deletes a team, and its projects and sessions go with it';
end $$;

-- 33. A team's project outlives the account that added it.
insert into teams (id, name, created_by)
values ('88888888-8888-8888-8888-888888888888', 'Keeps', '11111111-1111-1111-1111-111111111111');
insert into team_members (team_id, user_id, role)
values ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'owner'),
       ('88888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'admin');
insert into projects (owner_id, team_id, github_repo_id, full_name, owner, name)
values ('55555555-5555-5555-5555-555555555555', '88888888-8888-8888-8888-888888888888', 11, 'k/p', 'k', 'p');
delete from auth.users where id = '55555555-5555-5555-5555-555555555555';
do $$
begin
  if not exists (select 1 from projects where github_repo_id = 11 and owner_id is null) then
    raise exception 'FAIL: a team''s project went with the account that added it';
  end if;
  raise notice 'ok: a team''s project outlives whoever added it';
end $$;
