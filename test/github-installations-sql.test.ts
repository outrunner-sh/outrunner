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
const connect = (id = 42, githubId: number | null = 7, actor = ADMIN, org = NEW_ORG, owner: string | null = null) =>
  sql(`set role service_role; select link_github_installation('${org}', ${id}, ${githubId ?? "null"}, '${actor}', ${owner ? `'${owner}'` : "null"})`);
before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server); u.pathname = `/${name}`; url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table organizations (id uuid primary key, name text not null default 'org', personal_owner_id uuid);
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
    insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id, removed_from)
    values (45, 'previously-removed', 'Organization', 'all', 7, '${ORG}');
  `);
  for (const file of ["20261104100000_shared_github_installations.sql", "20261112130000_github_installation_sharing.sql"]) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
  // Supabase grants these on pre-existing tables; exercise the invoker RPC
  // as the actual service role rather than relying on the database owner.
  sql("grant select, update on github_installations to service_role; grant select on organization_members to service_role");
});
after(() => { if (server) psql(server, `drop database if exists ${name} with (force)`); });

const PERSONAL = "00000000-0000-0000-0000-000000000013";
const authority = (org: string, id: number) =>
  sql(`select coalesce(authority, 'legacy') || ':' || coalesce(authorized_github_id::text, '') from org_github_installations where org_id = '${org}' and installation_id = ${id}`);
const linked = (id: number) =>
  sql(`select coalesce(string_agg(org_id::text, ',' order by org_id), '') from org_github_installations where installation_id = ${id}`).split(",").filter(Boolean);

test("SQL: migration preserves existing and legacy connections, marked as made before the rule", { skip }, () => {
  assert.equal(sql(`select count(*) from org_github_installations where org_id = '${ORG}'`), "2");
  assert.equal(sql("select count(*) from github_installations"), "4");
  assert.equal(sql("select installed_by from org_github_installation_details where installation_id = 42"), ADMIN);
  assert.equal(authority(ORG, 42), "legacy:");
  assert.equal(sql("select authority is null from org_github_installation_details where installation_id = 43"), "t");
});

test("SQL: administering a connected org no longer lets an admin share it without GitHub's say", { skip }, () => {
  // ADMIN administers ORG (connected) and NEW_ORG, but isn't GitHub user 7.
  assert.equal(connect(42, 99), "not_installer");
  assert.equal(connect(42, null), "not_installer");
  // An installation from before installers were recorded: no one is its installer.
  assert.equal(connect(43, 7), "not_installer");
  assert.deepEqual(linked(42), [ORG]);
});

test("SQL: an org that was connected before can't be re-linked on that history alone", { skip }, () => {
  // 45 remembers ORG (removed_from, now connected_org_ids) but has no link.
  assert.equal(sql(`select '${ORG}'::uuid = any(connected_org_ids) from github_installations where installation_id = 45`), "t");
  assert.equal(connect(45, null, ADMIN, ORG), "not_installer");
  assert.equal(connect(45, 99, ADMIN, ORG), "not_installer");
  assert.equal(connect(45, 7, ADMIN, ORG), "");
  assert.equal(authority(ORG, 45), "installer:7");
});

test("SQL: the installer, or a GitHub owner the server verified, shares it; how is recorded", { skip }, () => {
  assert.equal(connect(), "");
  assert.equal(connect(), "", "idempotent");
  assert.equal(authority(NEW_ORG, 42), "installer:7");
  assert.equal(sql(`select installed_by from org_github_installations where org_id = '${ORG}' and installation_id = 42`), ADMIN);
  // Anything but the two verified kinds is refused.
  assert.equal(connect(43, 99, ADMIN, NEW_ORG, "admin"), "not_installer");
  assert.equal(connect(43, 99, ADMIN, NEW_ORG, "org_owner"), "");
  assert.equal(authority(NEW_ORG, 43), "org_owner:99");
  assert.equal(connect(44, 55, ADMIN, NEW_ORG, "account_owner"), "");
  assert.equal(authority(NEW_ORG, 44), "account_owner:55");
});

test("SQL: the destination must be administered, and the installation known", { skip }, () => {
  sql(`delete from org_github_installations where org_id = '${NEW_ORG}' and installation_id = 42`);
  sql(`update organization_members set role = 'member' where org_id = '${NEW_ORG}' and user_id = '${ADMIN}'`);
  assert.equal(connect(), "not_admin");
  sql(`update organization_members set role = 'admin' where org_id = '${NEW_ORG}' and user_id = '${ADMIN}'`);
  assert.equal(connect(999), "unknown");
  assert.equal(connect(), "");
});

test("SQL: a member removed from an org loses the links they made of its installations elsewhere", { skip }, () => {
  sql(`insert into organizations (id, name, personal_owner_id) values ('${PERSONAL}', 'Personal', '${ADMIN}');
       insert into organization_members values ('${PERSONAL}', '${ADMIN}', 'admin')`);
  // ADMIN shares ORG's installation into their personal org, as its installer.
  assert.equal(connect(42, 7, ADMIN, PERSONAL), "");
  // Their own user account's installation, in ORG and their personal org.
  assert.equal(connect(44, 7, ADMIN, ORG), "");
  assert.equal(connect(44, 7, ADMIN, PERSONAL), "");
  // OTHER's link of 43 into NEW_ORG isn't ADMIN's.
  sql(`delete from org_github_installations where org_id = '${NEW_ORG}' and installation_id = 43`);
  assert.equal(connect(43, 99, OTHER, NEW_ORG, "org_owner"), "");

  sql(`delete from organization_members where org_id = '${ORG}' and user_id = '${ADMIN}'`);

  assert.deepEqual(linked(42), [ORG], "the removed admin's shares of ORG's installation are gone");
  assert.deepEqual(linked(43), [ORG, NEW_ORG], "another member's share stays");
  assert.deepEqual(linked(44), [ORG, NEW_ORG, PERSONAL].sort(), "their own account's installation stays theirs");
  assert.deepEqual(linked(45), [ORG], "ORG's own links stay");
  // Unrelated memberships leaving touch nothing.
  sql(`delete from organization_members where org_id = '${PERSONAL}' and user_id = '${ADMIN}'`);
  assert.deepEqual(linked(44), [ORG, NEW_ORG, PERSONAL].sort());
  sql(`insert into organization_members values ('${ORG}', '${ADMIN}', 'admin'), ('${PERSONAL}', '${ADMIN}', 'admin')`);
});

test("SQL: only the source org lists and removes the orgs its installation is shared with", { skip }, () => {
  assert.equal(connect(42, 7, ADMIN, PERSONAL), "");
  assert.equal(connect(42, 7, ADMIN, NEW_ORG), "");
  const shares = (org: string) =>
    sql(`set role service_role; select string_agg(org_id || '|' || org_name || '|' || personal || '|' || coalesce(authority, 'legacy'), ';' order by linked_at, org_id) from github_installation_shares('${org}', 42)`);
  assert.equal(sql("set role service_role; select github_installation_source(42)"), ORG);
  const listed = shares(ORG).split(";");
  assert.equal(listed.length, 2);
  assert.ok(listed.includes(`${PERSONAL}|Personal|true|installer`));
  assert.equal(shares(NEW_ORG), "", "a share sees nothing");
  assert.equal(shares(PERSONAL), "");
  const remove = (source: string, target: string, id = 42) =>
    sql(`set role service_role; select remove_github_installation_share('${source}', ${id}, '${target}')`);
  assert.equal(remove(PERSONAL, NEW_ORG), "not_source");
  assert.equal(remove(NEW_ORG, ORG), "not_source", "a share can't remove the source");
  assert.equal(remove(ORG, ORG), "not_source");
  assert.equal(remove(ORG, PERSONAL), "");
  assert.equal(remove(ORG, PERSONAL), "not_shared");
  assert.equal(remove(ORG, PERSONAL, 999), "not_shared");
  assert.deepEqual(linked(42), [ORG, NEW_ORG]);
});

test("SQL: disconnect and organization deletion leave other organizations connected", { skip }, () => {
  sql(`delete from org_github_installations where org_id = '${NEW_ORG}' and installation_id = 42`);
  assert.equal(sql("select count(*) from github_installations where installation_id = 42"), "1");
  assert.deepEqual(linked(42), [ORG]);
  assert.equal(connect(), "");
  sql(`delete from organizations where id = '${NEW_ORG}'`);
  assert.deepEqual(linked(42), [ORG]);
});

test("SQL: GitHub suspension updates all connections; uninstall removes every link", { skip }, () => {
  sql(`insert into organizations (id) values ('${NEW_ORG}');
       insert into organization_members values ('${NEW_ORG}', '${ADMIN}', 'admin')`);
  assert.equal(connect(), "");
  sql("update github_installations set suspended_at = now() where installation_id = 42");
  assert.equal(sql("select count(*) from org_github_installation_details where installation_id = 42 and suspended_at is not null"), "2");
  sql("delete from github_installations where installation_id = 42");
  assert.equal(sql("select count(*) from org_github_installations where installation_id = 42"), "0");
});

test("SQL: browser clients cannot access links or invoke the connection RPCs", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    assert.throws(() => sql(`set role ${role}; select * from org_github_installations`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select * from org_github_installation_details`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select link_github_installation('${ORG}', 44, 7, '${ADMIN}')`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select * from github_installation_shares('${ORG}', 44)`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select remove_github_installation_share('${ORG}', 44, '${NEW_ORG}')`), /permission denied/);
  }
  for (const fn of [
    "link_github_installation(uuid,bigint,bigint,uuid,text)",
    "github_installation_shares(uuid,bigint)",
    "remove_github_installation_share(uuid,bigint,uuid)",
  ]) {
    assert.equal(sql(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t", fn);
  }
  assert.equal(sql("select count(*) from pg_proc where proname = 'link_github_installation'"), "1", "the old signature is gone");
});
