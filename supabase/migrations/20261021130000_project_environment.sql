-- A project's environment for its cloud sessions: the variables they run
-- with and the scripts Conductor ran around a workspace (setup on creation,
-- run on demand, archive before archiving) — imported from the user's Mac,
-- where a Conductor repository or a checkout's .env had them.
--
-- The variables, and the files a checkout keeps out of git (its .env files),
-- are secrets (API keys, database URLs), so the same treatment as
-- user_credentials: RLS on with no policy and every grant revoked, reached
-- only by the service role through lib/db/project-environment.ts. Both are one
-- AES-256-GCM sealed JSON object, {env, files} (lib/crypto/secret-box.ts);
-- the variables' names and the files' paths are kept beside it, for showing
-- without opening it.
-- ---------------------------------------------------------------------------

create table if not exists project_environment (
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  secrets_ciphertext text,
  env_names text[] not null default '{}',
  file_paths text[] not null default '{}',
  setup_script text,
  run_script text,
  archive_script text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, project_id)
);

drop trigger if exists project_environment_set_updated_at on project_environment;
create trigger project_environment_set_updated_at
  before update on project_environment
  for each row execute function set_updated_at();

alter table project_environment enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table project_environment from anon, authenticated;
