/** Org setup's completion (20261119110000_org_setup.sql), and the read-only
 *  query that dry-runs the rule (lib/orgs/setup.ts) on production before
 *  deploy, on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `org_setup_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);

/**
 * The orgs that would be sent through setup once this deploys: never set up
 * (nothing is, before it), no session, no environment someone made. Who
 * meets it: its admins go through setup, its other members wait. Read-only;
 * it runs before the migration, so it doesn't name setup_completed_at. The
 * PR's description carries the same query.
 */
const DRY_RUN = `
select o.id, o.name, o.personal_owner_id is not null as personal, o.created_at,
  (select count(*) from organization_members m where m.org_id = o.id and m.role = 'admin') as admins,
  (select count(*) from organization_members m where m.org_id = o.id and m.role <> 'admin') as members,
  (select count(*) from projects p where p.org_id = o.id) as repositories
from organizations o
where not exists (select 1 from workspaces w where w.org_id = o.id)
  and not exists (
    select 1 from environments e
    where e.org_id = o.id and e.archived_at is null and e.default_for_project_id is null
  )
order by o.created_at`;

const org = (orgName: string) => sql(`insert into organizations (name) values ('${orgName}') returning id`);
const repository = (orgId: string) => sql(`insert into projects (org_id) values ('${orgId}') returning id`);
const listed = () => sql(`select coalesce(string_agg(name, ',' order by name), '') from (${DRY_RUN}) d`);

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create table organizations (
      id uuid primary key default gen_random_uuid(), name text not null,
      personal_owner_id uuid, created_at timestamptz not null default now()
    );
    create table organization_members (org_id uuid references organizations (id), user_id uuid, role text);
    create table projects (id uuid primary key default gen_random_uuid(), org_id uuid references organizations (id));
    create table workspaces (id uuid primary key default gen_random_uuid(), org_id uuid references organizations (id));
    create table environments (
      id uuid primary key default gen_random_uuid(), org_id uuid references organizations (id),
      default_for_project_id uuid references projects (id), archived_at timestamptz
    );
    create table organization_settings (org_id uuid primary key references organizations (id));
  `);
  const migrate = () =>
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261119110000_org_setup.sql"], { stdio: "pipe" });
  migrate();
  // Run twice, as a deploy that retries would.
  migrate();
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("the dry run lists exactly the orgs the rule sends through setup", { skip }, () => {
  org("Empty");
  const used = org("Used");
  sql(`insert into workspaces (org_id) values ('${used}')`);
  // Only its repositories' own environments, made on first use: still not set up.
  const owns = org("Only own environments");
  const p = repository(owns);
  sql(`insert into environments (org_id, default_for_project_id) values ('${owns}', '${p}')`);
  const named = org("Named environment");
  sql(`insert into environments (org_id) values ('${named}')`);
  // An environment made and archived since isn't one it has.
  const archived = org("Archived environment");
  sql(`insert into environments (org_id, archived_at) values ('${archived}', now())`);
  assert.equal(listed(), "Archived environment,Empty,Only own environments");
});

test("an org keeps when its setup was done", { skip }, () => {
  assert.equal(sql(`select data_type from information_schema.columns where table_name = 'organization_settings' and column_name = 'setup_completed_at'`), "timestamp with time zone");
  const acme = org("Acme");
  sql(`insert into organization_settings (org_id, setup_completed_at) values ('${acme}', now())`);
  assert.equal(sql(`select count(*) from organization_settings where org_id = '${acme}' and setup_completed_at is not null`), "1");
});
