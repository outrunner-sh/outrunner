-- Automations, step two: an org's automations. Each is a saved prompt with
-- GitHub triggers (a pull request opened, or given new commits) on some of
-- the org's repositories; when one fires, a session runs the prompt as the
-- automation's runner (their Claude and plan) and posts as the Outrunner
-- GitHub App (20261029100000_github_installations.sql). Runs come next.
--
-- The org's admins make and change them; every member sees them. Whoever
-- last changed what an automation does (its prompt, triggers or
-- repositories) is who it runs as: no admin spends another's account on a
-- prompt they didn't write. Renaming it, or switching it off and on again,
-- leaves it on its runner's account: they chose what it does. One whose
-- runner left the org (or lost their account) runs as no one until an
-- admin saves it from the editor, which sends its repositories: they then
-- take it on. The list's on/off switch never does.
--
-- The server's alone (RLS on, no policy, grants revoked), reached through
-- lib/db/automations.ts, whose routes check who may. Making one, and changing
-- one, each go through a function below: one transaction, the repositories
-- checked to be the org's in it.
-- ---------------------------------------------------------------------------

create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Who it runs as. Gone with their account: it then stops running.
  runs_as uuid references auth.users (id) on delete set null,
  name text not null check (char_length(name) between 1 and 80),
  -- The template it was made from (lib/automations/templates.ts), if any.
  template text,
  prompt text not null check (char_length(prompt) between 1 and 20000),
  triggers text[] not null
    check (cardinality(triggers) > 0 and triggers <@ array['pull_request.opened', 'pull_request.synchronize']),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automations_org_idx on automations (org_id, created_at);

alter table automations enable row level security;
revoke all on table automations from anon, authenticated;

-- The repositories (projects) an automation runs on: the org's own.
create table if not exists automation_repos (
  automation_id uuid not null references automations (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  primary key (automation_id, project_id)
);

create index if not exists automation_repos_project_idx on automation_repos (project_id);

alter table automation_repos enable row level security;
revoke all on table automation_repos from anon, authenticated;

-- Point an automation at `project_ids`, every one the org's, or raise
-- 'foreign_repo' (SQLSTATE OR001, which lib/db/automations.ts reads).
create or replace function set_automation_repos(target_org uuid, automation uuid, project_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from unnest(project_ids) as wanted (id)
    where not exists (select 1 from projects p where p.id = wanted.id and p.org_id = target_org)
  ) then
    raise exception 'foreign_repo' using errcode = 'OR001';
  end if;
  delete from automation_repos where automation_id = automation;
  insert into automation_repos (automation_id, project_id)
  select automation, id from unnest(project_ids) as wanted (id)
  on conflict do nothing;
end;
$$;

-- Make an automation of `target_org`, run as `runner`, on `project_ids`. Its id.
create or replace function create_automation(
  target_org uuid,
  runner uuid,
  automation_name text,
  automation_template text,
  automation_prompt text,
  automation_triggers text[],
  is_enabled boolean,
  project_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  made uuid;
begin
  insert into automations (org_id, runs_as, name, template, prompt, triggers, enabled)
  values (target_org, runner, automation_name, automation_template, automation_prompt, automation_triggers, is_enabled)
  returning id into made;
  perform set_automation_repos(target_org, made, project_ids);
  return made;
end;
$$;

-- Change an automation of `target_org`: each argument given (not null) is
-- set. Changing what it does (prompt, triggers, repositories) makes `editor`
-- who it runs as: compared with what's stored, so sending a field unchanged
-- changes no one, unless its runner is no longer in the org, when sending
-- any of those (an editor's Save) takes it on. False when the org has no
-- automation by that id.
create or replace function update_automation(
  target_org uuid,
  automation uuid,
  editor uuid,
  automation_name text,
  automation_prompt text,
  automation_triggers text[],
  is_enabled boolean,
  project_ids uuid[]
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current automations%rowtype;
  repos_change boolean := false;
begin
  -- Locked, so two changes to one automation run one after the other.
  select * into current from automations where id = automation and org_id = target_org for update;
  if not found then
    return false;
  end if;
  if project_ids is not null then
    repos_change := array(select distinct unnest(project_ids) order by 1)
      is distinct from array(select project_id from automation_repos where automation_id = automation order by 1);
  end if;
  update automations set
    name = coalesce(automation_name, name),
    prompt = coalesce(automation_prompt, prompt),
    triggers = coalesce(automation_triggers, triggers),
    enabled = coalesce(is_enabled, enabled),
    runs_as = case
      when coalesce(automation_prompt, current.prompt) is distinct from current.prompt
        or array(select distinct unnest(coalesce(automation_triggers, current.triggers)) order by 1)
          is distinct from array(select distinct unnest(current.triggers) order by 1)
        or repos_change
        -- And whenever its runner is gone or no longer in the org, on a
        -- save of what it does (an editor's Save sends its repositories),
        -- never on a rename or the on/off switch alone.
        or (
          (automation_prompt is not null or automation_triggers is not null or project_ids is not null)
          and not exists (
            select 1 from organization_members m where m.org_id = target_org and m.user_id = current.runs_as
          )
        )
      then editor
      else runs_as
    end,
    updated_at = now()
  where id = automation;
  if project_ids is not null then
    -- Even unchanged: it checks every repository is still the org's.
    perform set_automation_repos(target_org, automation, project_ids);
  end if;
  return true;
end;
$$;

revoke all on function set_automation_repos(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[]) from public, anon, authenticated;
revoke all on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[]) from public, anon, authenticated;
grant execute on function set_automation_repos(uuid, uuid, uuid[]) to service_role;
grant execute on function create_automation(uuid, uuid, text, text, text, text[], boolean, uuid[]) to service_role;
grant execute on function update_automation(uuid, uuid, uuid, text, text, text[], boolean, uuid[]) to service_role;
