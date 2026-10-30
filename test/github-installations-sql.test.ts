/** The shared-installation migration on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";

const server = process.env.GITHUB_INSTALLATIONS_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `github_links_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ADMIN = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const NEW_ORG = "00000000-0000-0000-0000-000000000012";
let url = "";
function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
const connect = (id = 42, githubId: number | null = 7, actor = ADMIN, org = NEW_ORG) =>
  sql(`set role service_role; select link_github_installation('${org}', ${id}, ${githubId ?? 'null'}, '${actor}')`);
before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server); u.pathname = `/${name}`; url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table organizations (id uuid primary key);
    create table organization_members (org_id uuid references organizations(id) on delete cascade, user_id uuid, role text, primary key(org_id, user_id));
    create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    insert into auth.users values ('${ADMIN}'), ('${OTHER}');
    insert into organizations values ('${ORG}'), ('${NEW_ORG}');
    insert into organization_members values ('${ORG}', '${ADMIN}', 'admin'), ('${NEW_ORG}', '${ADMIN}', 'admin'), ('${NEW_ORG}', '${OTHER}', 'admin');
  `);
  for (const file of ["20261029100000_github_installations.sql", "20261029110000_github_installations_claim.sql"]) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
  sql(`
    insert into github_installations (installation_id, org_id, account_login, account_type, repository_selection, installed_by, installer_id)
    values (42, '${ORG}', 'neevai-labs', 'Organization', 'all', '${ADMIN}', 7),
           (43, '${ORG}', 'legacy', 'Organization', 'selected', '${ADMIN}', null),
           (44, null, 'fresh', 'User', 'all', null, 7);
  `);
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261104100000_shared_github_installations.sql"], { stdio: "pipe" });
  // Supabase grants these on pre-existing tables; exercise the invoker RPC
  // as the actual service role rather than relying on the database owner.
  sql("grant select, update on github_installations to service_role; grant select on organization_members to service_role");
});
after(() => { if (server) psql(server, `drop database if exists ${name} with (force)`); });

test("SQL: migration preserves existing and legacy connections", { skip }, () => {
  assert.equal(sql(`select count(*) from org_github_installations where org_id = '${ORG}'`), "2");
  assert.equal(sql("select count(*) from github_installations"), "3");
  assert.equal(sql("select installed_by from org_github_installation_details where installation_id = 42"), ADMIN);
});

test("SQL: one installation connects to two organizations without moving the first; retry is idempotent", { skip }, () => {
  assert.equal(connect(), "");
  assert.equal(connect(), "");
  assert.equal(sql("select count(*) from org_github_installation_details where installation_id = 42"), "2");
  assert.equal(sql(`select installed_by from org_github_installations where org_id = '${ORG}' and installation_id = 42`), ADMIN);
});

test("SQL: first connections require the installer; sharing requires administration of both orgs", { skip }, () => {
  sql(`delete from org_github_installations where org_id = '${NEW_ORG}' and installation_id = 42`);
  assert.equal(connect(44, 99), "not_installer");
  assert.equal(connect(44, null), "not_installer");
  assert.equal(connect(42, 7, OTHER), "not_admin");
  sql(`update organization_members set role = 'member' where org_id = '${NEW_ORG}' and user_id = '${ADMIN}'`);
  assert.equal(connect(), "not_admin");
  sql(`update organization_members set role = 'admin' where org_id = '${NEW_ORG}' and user_id = '${ADMIN}'`);
  assert.equal(connect(999), "unknown");
  assert.equal(connect(43, null), "");
  assert.equal(connect(42, null), "");
  assert.equal(connect(44), "");
  assert.equal(connect(), "");
});

test("SQL: disconnect and organization deletion leave other organizations connected", { skip }, () => {
  sql(`delete from org_github_installations where org_id = '${NEW_ORG}' and installation_id = 42`);
  assert.equal(sql("select count(*) from github_installations where installation_id = 42"), "1");
  assert.equal(sql("select org_id from org_github_installation_details where installation_id = 42"), ORG);
  assert.equal(connect(), "");
  sql(`delete from organizations where id = '${NEW_ORG}'`);
  assert.equal(sql("select org_id from org_github_installation_details where installation_id = 42"), ORG);
});

test("SQL: GitHub suspension updates all connections; uninstall removes every link", { skip }, () => {
  sql(`insert into organizations values ('${NEW_ORG}');
       insert into organization_members values ('${NEW_ORG}', '${ADMIN}', 'admin')`);
  assert.equal(connect(), "");
  sql("update github_installations set suspended_at = now() where installation_id = 42");
  assert.equal(sql("select count(*) from org_github_installation_details where installation_id = 42 and suspended_at is not null"), "2");
  sql("delete from github_installations where installation_id = 42");
  assert.equal(sql("select count(*) from org_github_installations where installation_id = 42"), "0");
});

test("SQL: browser clients cannot access links or invoke the connection RPC", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    assert.throws(() => sql(`set role ${role}; select * from org_github_installations`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select * from org_github_installation_details`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select link_github_installation('${ORG}', 44, 7, '${ADMIN}')`), /permission denied/);
  }
  assert.equal(sql("select has_function_privilege('service_role', 'link_github_installation(uuid,bigint,bigint,uuid)', 'execute')"), "t");
});
