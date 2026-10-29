-- A project's skills (an `environments` row: what the app calls a Project),
-- installed on every new session's box for Claude Code and Codex
-- (lib/db/environment-skills.ts, runtime-agent/internal/workspace/skills.go).
--
-- Two kinds, as Replicas has them:
--
-- - environment_skills: one skill picked from the skills.sh catalog, by its
--   catalog id (owner/repo/skill), installed from that GitHub repository.
-- - environment_skill_registries: a GitHub repository whose every skill
--   installs, read with the org's GitHub App or the member's own token.
--
-- Neither holds a secret, but both follow environment_repos: in the
-- project's org, taken from the project and never chosen, gone with it, and
-- reached only by the service role through lib/db (RLS on, no policy).
-- ---------------------------------------------------------------------------

create table if not exists environment_skills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  environment_id uuid not null,
  -- The catalog's id for it, owner/repo/skill, and its parts.
  slug text not null check (char_length(slug) between 3 and 300),
  name text not null check (char_length(name) between 1 and 200),
  source text not null check (source ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'),
  skill text not null check (skill ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint environment_skills_slug_unique unique (environment_id, slug),
  constraint environment_skills_environment_fkey
    foreign key (org_id, environment_id) references environments (org_id, id) on delete cascade
);

create table if not exists environment_skill_registries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  environment_id uuid not null,
  -- owner/name, as GitHub had it when added.
  full_name text not null check (full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'),
  -- The branch its skills are read from: its default when added.
  default_branch text not null check (char_length(default_branch) between 1 and 255),
  private boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint environment_skill_registries_environment_fkey
    foreign key (org_id, environment_id) references environments (org_id, id) on delete cascade
);

-- GitHub's names are case-blind: acme/Skills is acme/skills.
create unique index if not exists environment_skill_registries_repo_unique
  on environment_skill_registries (environment_id, lower(full_name));

create index if not exists environment_skills_environment_idx on environment_skills (environment_id, created_at);

-- Taken from the project, never chosen (as environment_repos_org).
create or replace function environment_skills_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  select org_id into new.org_id from environments where id = new.environment_id;
  return new;
end;
$$;

drop trigger if exists environment_skills_org on environment_skills;
create trigger environment_skills_org
  before insert or update of environment_id on environment_skills
  for each row execute function environment_skills_org();

drop trigger if exists environment_skill_registries_org on environment_skill_registries;
create trigger environment_skill_registries_org
  before insert or update of environment_id on environment_skill_registries
  for each row execute function environment_skills_org();

drop trigger if exists environment_skills_set_updated_at on environment_skills;
create trigger environment_skills_set_updated_at
  before update on environment_skills
  for each row execute function set_updated_at();

drop trigger if exists environment_skill_registries_set_updated_at on environment_skill_registries;
create trigger environment_skill_registries_set_updated_at
  before update on environment_skill_registries
  for each row execute function set_updated_at();

alter table environment_skills enable row level security;
revoke all on table environment_skills from anon, authenticated;
alter table environment_skill_registries enable row level security;
revoke all on table environment_skill_registries from anon, authenticated;
