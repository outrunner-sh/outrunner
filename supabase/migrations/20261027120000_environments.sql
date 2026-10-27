-- Environments: what the app calls a Project. One or more repositories (up
-- to five) and what their cloud sessions start with: the variables, the files
-- a checkout keeps out of git, the setup, run and archive scripts, and the
-- instructions the agent is given.
--
-- Naming: the UI's "Project" is a row here. The `projects` table keeps what
-- it always held, one GitHub repository the owner has connected, and is the
-- list an environment's repositories come from (environment_repos). Each
-- repository gets a default environment holding just it
-- (default_for_project_id), made here for the ones in use and on first use
-- for the rest (lib/db/environments.ts), so picking a repository picks it.
--
-- The variables and files are secrets, so the same treatment as
-- project_environment, whose rows move here: RLS on with no policy and every
-- grant revoked, reached only by the service role through
-- lib/db/environments.ts; one AES-256-GCM sealed JSON object, {env, files}
-- (lib/crypto/secret-box.ts), the names and paths beside it. project_environment
-- stays, unread, for one release.
-- ---------------------------------------------------------------------------

create table if not exists environments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  instructions text check (instructions is null or char_length(instructions) <= 16384),
  secrets_ciphertext text,
  env_names text[] not null default '{}',
  file_paths text[] not null default '{}',
  setup_script text,
  run_script text,
  archive_script text,
  -- The repository this is the default environment of; null for one the
  -- user made.
  default_for_project_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint environments_owner_id_unique unique (owner_id, id),
  constraint environments_default_project_fkey
    foreign key (owner_id, default_for_project_id)
    references projects (owner_id, id) on delete cascade
);

create unique index if not exists environments_default_project_unique
  on environments (owner_id, default_for_project_id)
  where default_for_project_id is not null;

drop trigger if exists environments_set_updated_at on environments;
create trigger environments_set_updated_at
  before update on environments
  for each row execute function set_updated_at();

alter table environments enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table environments from anon, authenticated;

-- An environment's repositories, each cloned into its own folder,
-- checkout_name, in `position` order.
create table if not exists environment_repos (
  owner_id uuid not null,
  environment_id uuid not null,
  project_id uuid not null,
  checkout_name text not null
    check (checkout_name ~ '^[A-Za-z0-9._-]{1,100}$' and checkout_name not in ('.', '..')),
  -- The branch its sessions start from; null is the repository's default.
  branch text check (branch is null or char_length(branch) between 1 and 255),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (environment_id, project_id),
  constraint environment_repos_checkout_unique unique (environment_id, checkout_name),
  constraint environment_repos_environment_fkey
    foreign key (owner_id, environment_id)
    references environments (owner_id, id) on delete cascade,
  constraint environment_repos_project_fkey
    foreign key (owner_id, project_id)
    references projects (owner_id, id) on delete cascade
);

create index if not exists environment_repos_project_idx on environment_repos (owner_id, project_id);

-- At most five repositories: each is cloned on every box of the environment.
create or replace function environment_repos_limit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Two added at once would each count four.
  perform pg_advisory_xact_lock(hashtext('environment_repos:' || new.environment_id::text));
  if (select count(*) from environment_repos where environment_id = new.environment_id) >= 5 then
    raise exception 'an environment holds at most 5 repositories';
  end if;
  return new;
end;
$$;

drop trigger if exists environment_repos_limit on environment_repos;
create trigger environment_repos_limit
  before insert on environment_repos
  for each row execute function environment_repos_limit();

alter table environment_repos enable row level security;
revoke all on table environment_repos from anon, authenticated;

-- The environment a session started from; null for one from before, and set
-- null (not the owner) if the environment goes.
alter table workspaces
  add column if not exists environment_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_environment_fkey'
  ) then
    alter table workspaces
      add constraint workspaces_environment_fkey
        foreign key (owner_id, environment_id)
        references environments (owner_id, id) on delete set null (environment_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Backfill: a default environment for every repository in use (it has
-- sessions, or a kept environment), carrying its project_environment over.
-- ---------------------------------------------------------------------------

insert into environments (
  owner_id, name, default_for_project_id,
  secrets_ciphertext, env_names, file_paths, setup_script, run_script, archive_script
)
select
  p.owner_id,
  left(p.name, 80),
  p.id,
  pe.secrets_ciphertext,
  coalesce(pe.env_names, '{}'),
  coalesce(pe.file_paths, '{}'),
  pe.setup_script,
  pe.run_script,
  pe.archive_script
from projects p
left join project_environment pe
  on pe.owner_id = p.owner_id and pe.project_id = p.id
where (
    pe.project_id is not null
    or exists (select 1 from workspaces w where w.owner_id = p.owner_id and w.project_id = p.id)
  )
  and not exists (
    select 1 from environments e
    where e.owner_id = p.owner_id and e.default_for_project_id = p.id
  );

insert into environment_repos (owner_id, environment_id, project_id, checkout_name)
select e.owner_id, e.id, e.default_for_project_id, left(regexp_replace(p.name, '[^A-Za-z0-9._-]', '-', 'g'), 100)
from environments e
join projects p on p.owner_id = e.owner_id and p.id = e.default_for_project_id
where not exists (
  select 1 from environment_repos r where r.environment_id = e.id
);

-- Without touching updated_at: the app reads it as the session's last change
-- (a stalled setup, say).
alter table workspaces disable trigger workspaces_set_updated_at;

update workspaces w
set environment_id = e.id
from environments e
where w.environment_id is null
  and e.owner_id = w.owner_id
  and e.default_for_project_id = w.project_id;

alter table workspaces enable trigger workspaces_set_updated_at;
