-- People start sessions from environments (Replicas' model): an org picks
-- the repositories it works on and groups them into named environments, one
-- of which is the org's default, picked first on the new-session screen.
--
-- Every repository also has its own environment, made on its first session
-- (make_default_environment, 20261028145000_org_access.sql), which the API's
-- by-repository calls and automations start from. Those aren't listed with
-- the environments people made, unless someone made one their own: see
-- environment_listed below.
-- ---------------------------------------------------------------------------

-- The environment the org's new sessions start from unless another is
-- picked. Set by an admin (lib/db/environments.ts); an environment deleted
-- leaves none. Not a team-only default: a personal org has one too, and
-- organization_settings_team_only (20261114120000_usage_limits_in_dollars.sql)
-- refuses only a personal org's session defaults, not this.
alter table organization_settings
  add column if not exists default_environment_id uuid references environments (id) on delete set null;

-- Whether an environment is listed with the ones people made (the
-- Environments page, the new-session picker), as against a repository's own
-- that nobody has touched. Listed: one made by someone (no
-- default_for_project_id), and a repository's own once it holds anything of
-- its own: a name other than the repository's, a description,
-- instructions, a variable or file, a script or hook, another repository,
-- a skill or skill registry, an MCP server, or a secret sync link. The
-- org's default is always listed.
create or replace function environment_listed(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.default_for_project_id is null
    or exists (select 1 from public.organization_settings s where s.org_id = e.org_id and s.default_environment_id = e.id)
    or e.name is distinct from (select left(p.name, 80) from public.projects p where p.id = e.default_for_project_id)
    or coalesce(e.description, '') ~ '\S'
    or coalesce(e.instructions, '') ~ '\S'
    or cardinality(e.env_names) > 0
    or cardinality(e.file_paths) > 0
    or coalesce(e.setup_script, '') ~ '\S'
    or coalesce(e.run_script, '') ~ '\S'
    or coalesce(e.archive_script, '') ~ '\S'
    or coalesce(e.warm_hook, '') ~ '\S'
    or coalesce(e.start_hook, '') ~ '\S'
    or exists (select 1 from public.environment_repos r where r.environment_id = e.id and r.project_id <> e.default_for_project_id)
    or exists (select 1 from public.environment_skills k where k.environment_id = e.id)
    or exists (select 1 from public.environment_skill_registries g where g.environment_id = e.id)
    or exists (select 1 from public.environment_mcp_servers m where m.environment_id = e.id)
    or exists (select 1 from public.environment_secret_links l where l.environment_id = e.id)
  from public.environments e
  where e.id = target
$$;

-- The org's listed environments `member` may read (environment_level: read
-- on every one of its repositories), by name: each with its repositories in
-- their order, and whether it's the org's default. One call for the
-- sidebar's data, rather than a read per environment.
create or replace function listed_environments(member uuid, target_org uuid)
returns table (
  id uuid,
  name text,
  default_for_project_id uuid,
  org_default boolean,
  repos jsonb,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id,
    e.name,
    e.default_for_project_id,
    coalesce(s.default_environment_id = e.id, false),
    coalesce(
      (
        select jsonb_agg(jsonb_build_object('projectId', p.id, 'fullName', p.full_name) order by r.position, r.created_at)
        from public.environment_repos r
        join public.projects p on p.id = r.project_id
        where r.environment_id = e.id
      ),
      '[]'::jsonb
    ),
    e.updated_at
  from public.environments e
  left join public.organization_settings s on s.org_id = e.org_id
  where e.org_id = target_org
    and e.archived_at is null
    and public.environment_listed(e.id)
    and public.environment_level(member, e.id) is not null
  order by lower(e.name), e.created_at
$$;

-- They answer for any member and any org: the server's alone.
revoke all on function environment_listed(uuid) from public, anon, authenticated;
revoke all on function listed_environments(uuid, uuid) from public, anon, authenticated;
grant execute on function environment_listed(uuid) to service_role;
grant execute on function listed_environments(uuid, uuid) to service_role;
