/** Which environments are listed, and the org's default
 *  (20261119100000_environments_model.sql), on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `environments_model_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);

/** An org's id. */
const org = () => sql(`insert into organizations (name) values ('Acme') returning id`);

/** A connected repository of `orgId`, named `repo`; its id. */
const repository = (orgId: string, repo: string) =>
  sql(`insert into projects (org_id, name, full_name) values ('${orgId}', '${repo}', 'acme/${repo}') returning id`);

/** A repository's own environment, as make_default_environment makes it:
 *  named after it, holding it alone. */
function ownEnvironment(orgId: string, projectId: string, repo: string): string {
  const id = sql(`insert into environments (org_id, name, default_for_project_id) values ('${orgId}', '${repo}', '${projectId}') returning id`);
  sql(`insert into environment_repos (environment_id, project_id) values ('${id}', '${projectId}')`);
  return id;
}

/** An environment someone made, of these repositories. */
function madeEnvironment(orgId: string, envName: string, projectIds: string[]): string {
  const id = sql(`insert into environments (org_id, name) values ('${orgId}', '${envName}') returning id`);
  projectIds.forEach((p, position) => sql(`insert into environment_repos (environment_id, project_id, position) values ('${id}', '${p}', ${position})`));
  return id;
}

/** Let `member` read the environment (the stand-in environment_level). */
const grant = (member: string, environmentId: string) => sql(`insert into test_access values ('${member}', '${environmentId}')`);

/** The listed environments `member` sees in `orgId`, as `name[:default]`. */
const listed = (member: string, orgId: string) =>
  sql(
    `set role service_role; select coalesce(string_agg(name || case when org_default then ':default' else '' end, ',' order by lower(name)), '') from listed_environments('${member}', '${orgId}')`,
  );

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create table organizations (id uuid primary key default gen_random_uuid(), name text not null);
    create table projects (
      id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations (id) on delete cascade,
      name text not null, full_name text not null
    );
    create table environments (
      id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations (id) on delete cascade,
      name text not null, description text, instructions text,
      env_names text[] not null default '{}', file_paths text[] not null default '{}',
      setup_script text, run_script text, archive_script text, warm_hook text, start_hook text,
      default_for_project_id uuid references projects (id) on delete cascade, archived_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table environment_repos (
      environment_id uuid not null references environments (id) on delete cascade,
      project_id uuid not null references projects (id) on delete cascade,
      position int not null default 0, created_at timestamptz not null default now()
    );
    create table environment_skills (environment_id uuid not null references environments (id) on delete cascade);
    create table environment_skill_registries (environment_id uuid not null references environments (id) on delete cascade);
    create table environment_mcp_servers (environment_id uuid not null references environments (id) on delete cascade);
    create table environment_secret_links (environment_id uuid not null references environments (id) on delete cascade);
    create table organization_settings (org_id uuid primary key references organizations (id) on delete cascade);
    -- environment_level (20261028145000_org_access.sql) stood in for: read
    -- where a row says so, nothing elsewhere.
    create table test_access (member uuid, environment_id uuid);
    create function environment_level(member uuid, target_environment uuid) returns text language sql stable as $$
      select case when exists (select 1 from public.test_access a where a.member = $1 and a.environment_id = $2) then 'write' end
    $$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    alter role service_role bypassrls;
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to service_role;
  `);
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261119100000_environments_model.sql"], { stdio: "pipe" });
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("a repository's untouched own environment isn't listed; one someone made is, with its repositories in order", { skip }, () => {
  const acme = org();
  const member = randomUUID();
  const web = repository(acme, "web");
  const api = repository(acme, "api");
  grant(member, ownEnvironment(acme, web, "web"));
  const made = madeEnvironment(acme, "Acme", [api, web]);
  grant(member, made);
  assert.equal(listed(member, acme), "Acme");
  assert.equal(
    sql(`set role service_role; select repos::text from listed_environments('${member}', '${acme}')`),
    `[{"fullName": "acme/api", "projectId": "${api}"}, {"fullName": "acme/web", "projectId": "${web}"}]`,
  );
});

test("a repository's own environment is listed once it holds anything of its own", { skip }, () => {
  const member = randomUUID();
  const changes: Record<string, (envId: string, orgId: string) => void> = {
    renamed: (e) => sql(`update environments set name = 'Web app' where id = '${e}'`),
    described: (e) => sql(`update environments set description = 'The site' where id = '${e}'`),
    instructed: (e) => sql(`update environments set instructions = 'Use pnpm' where id = '${e}'`),
    variables: (e) => sql(`update environments set env_names = '{API_TOKEN}' where id = '${e}'`),
    files: (e) => sql(`update environments set file_paths = '{.env}' where id = '${e}'`),
    setup: (e) => sql(`update environments set setup_script = 'pnpm install' where id = '${e}'`),
    "warm hook": (e) => sql(`update environments set warm_hook = 'pnpm build' where id = '${e}'`),
    skill: (e) => sql(`insert into environment_skills values ('${e}')`),
    registry: (e) => sql(`insert into environment_skill_registries values ('${e}')`),
    mcp: (e) => sql(`insert into environment_mcp_servers values ('${e}')`),
    "secret sync": (e) => sql(`insert into environment_secret_links values ('${e}')`),
    "another repository": (e, o) => sql(`insert into environment_repos (environment_id, project_id) values ('${e}', '${repository(o, "other")}')`),
  };
  for (const [what, change] of Object.entries(changes)) {
    const acme = org();
    const web = repository(acme, "web");
    const own = ownEnvironment(acme, web, "web");
    grant(member, own);
    assert.equal(listed(member, acme), "", `${what}: untouched`);
    change(own, acme);
    assert.notEqual(listed(member, acme), "", what);
  }
});

test("blank scripts and text don't count as making it one's own", { skip }, () => {
  const acme = org();
  const member = randomUUID();
  const web = repository(acme, "web");
  const own = ownEnvironment(acme, web, "web");
  grant(member, own);
  sql(`update environments set setup_script = '  ', description = '', instructions = E'\\n' where id = '${own}'`);
  assert.equal(listed(member, acme), "");
});

test("the org's default is marked, and listed whatever it is", { skip }, () => {
  const acme = org();
  const member = randomUUID();
  const web = repository(acme, "web");
  const own = ownEnvironment(acme, web, "web");
  const made = madeEnvironment(acme, "Acme", [web]);
  grant(member, own);
  grant(member, made);
  sql(`insert into organization_settings (org_id, default_environment_id) values ('${acme}', '${made}')`);
  assert.equal(listed(member, acme), "Acme:default");
  sql(`update organization_settings set default_environment_id = '${own}' where org_id = '${acme}'`);
  assert.equal(listed(member, acme), "Acme,web:default");
});

test("only what the member may read, of this org, not archived", { skip }, () => {
  const acme = org();
  const other = org();
  const member = randomUUID();
  const web = repository(acme, "web");
  const hidden = madeEnvironment(acme, "Hidden", [web]);
  const archived = madeEnvironment(acme, "Old", [web]);
  sql(`update environments set archived_at = now() where id = '${archived}'`);
  grant(member, archived);
  const elsewhere = madeEnvironment(other, "Elsewhere", [repository(other, "x")]);
  grant(member, elsewhere);
  assert.equal(listed(member, acme), "");
  grant(member, hidden);
  assert.equal(listed(member, acme), "Hidden");
});

test("a default environment deleted leaves the org none", { skip }, () => {
  const acme = org();
  const made = madeEnvironment(acme, "Acme", [repository(acme, "web")]);
  sql(`insert into organization_settings (org_id, default_environment_id) values ('${acme}', '${made}')`);
  sql(`delete from environments where id = '${made}'`);
  assert.equal(sql(`select coalesce(default_environment_id::text, 'none') from organization_settings where org_id = '${acme}'`), "none");
});

test("the new functions are the server's alone", { skip }, () => {
  for (const fn of ["environment_listed(uuid)", "listed_environments(uuid, uuid)"]) {
    assert.equal(sql(`select has_function_privilege('authenticated', '${fn}', 'execute')`), "f", fn);
    assert.equal(sql(`select has_function_privilege('anon', '${fn}', 'execute')`), "f", fn);
    assert.equal(sql(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t", fn);
  }
});
