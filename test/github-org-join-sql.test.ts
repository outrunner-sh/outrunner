/** Joining a team org as a member of its GitHub organization
 *  (20261119100000_github_org_join.sql) on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `github_org_join_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);

/** A fresh user's id. */
function user(): string {
  const id = randomUUID();
  sql(`insert into auth.users values ('${id}')`);
  return id;
}

/** A team org (or `personal` one) with `admin` as its admin; its id. */
function org(admin: string, personal = false): string {
  const id = sql(
    `insert into organizations (name, personal_owner_id) values ('Org', ${personal ? `'${admin}'` : "null"}) returning id`,
  );
  sql(`insert into organization_members (org_id, user_id, role) values ('${id}', '${admin}', 'admin')`);
  return id;
}

let nextInstallation = 1000;

/** An installation on GitHub organization `login`, connected to `source` and
 *  recorded as its source org; its id. */
function installation(source: string, login: string, extra: { accountType?: string; suspended?: boolean } = {}): number {
  const id = nextInstallation++;
  sql(`
    insert into github_installations (installation_id, account_login, account_type, suspended_at, source_org_id)
    values (${id}, '${login}', '${extra.accountType ?? "Organization"}', ${extra.suspended ? "now()" : "null"}, '${source}');
    insert into org_github_installations (org_id, installation_id) values ('${source}', ${id});
  `);
  return id;
}

/** What the server's call says, as the server makes it. */
const join = (target: string, member: string, githubOrg: string, installationId: number) =>
  sql(`set role service_role; select join_org_via_github('${target}', '${member}', '${githubOrg}', ${installationId})`);

const membership = (target: string, member: string) =>
  sql(`select role || ':' || coalesce(joined_via_github, '') from organization_members where org_id = '${target}' and user_id = '${member}'`);

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table organizations (
      id uuid primary key default gen_random_uuid(), name text not null,
      personal_owner_id uuid references auth.users (id) on delete cascade
    );
    create table organization_members (
      org_id uuid references organizations (id) on delete cascade,
      user_id uuid references auth.users (id) on delete cascade,
      role text not null, created_at timestamptz not null default now(), primary key (org_id, user_id)
    );
    create table organization_removals (
      org_id uuid not null references organizations (id) on delete cascade,
      user_id uuid not null references auth.users (id) on delete cascade,
      removed_by uuid references auth.users (id) on delete set null,
      removed_at timestamptz not null default now(),
      primary key (org_id, user_id)
    );
    create table organization_settings (
      org_id uuid primary key references organizations (id) on delete cascade,
      automations_on_harness boolean not null default false
    );
    create table github_installations (
      installation_id bigint primary key, account_login text not null,
      account_type text not null check (account_type in ('User', 'Organization')),
      suspended_at timestamptz, source_org_id uuid references organizations (id) on delete set null
    );
    create table org_github_installations (
      org_id uuid references organizations (id) on delete cascade,
      installation_id bigint references github_installations (installation_id) on delete cascade,
      primary key (org_id, installation_id)
    );
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    alter role service_role bypassrls;
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to service_role;
  `);
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261119100000_github_org_join.sql"], {
    stdio: "pipe",
  });
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("a member of the source org's GitHub organization joins once, as a member, recorded as through it", { skip }, () => {
  const team = org(user());
  const install = installation(team, "Acme");
  const grace = user();

  assert.equal(join(team, grace, "acme", install), "joined", "the login matches whatever its case");
  assert.equal(membership(team, grace), "member:acme");
  assert.equal(join(team, grace, "acme", install), "member", "again: a member already, nothing changes");
  assert.equal(sql(`select count(*) from organization_members where org_id = '${team}'`), "2");
});

test("the setting defaults to on; turned off, no one joins this way", { skip }, () => {
  assert.equal(sql(`select column_default from information_schema.columns where table_name = 'organization_settings' and column_name = 'join_via_github'`), "true");
  const team = org(user());
  const install = installation(team, "offco");
  sql(`insert into organization_settings (org_id) values ('${team}')`);
  assert.equal(join(team, user(), "offco", install), "joined", "a settings row for other settings leaves it on");

  sql(`update organization_settings set join_via_github = false where org_id = '${team}'`);
  const late = user();
  assert.equal(join(team, late, "offco", install), "disabled");
  assert.equal(membership(team, late), "");
});

test("a personal org is no one else's to join", { skip }, () => {
  const owner = user();
  const personal = org(owner, true);
  const install = installation(personal, "solo");
  assert.equal(join(personal, user(), "solo", install), "personal");
});

test("only the installation's source org, on that GitHub organization, connected and not suspended", { skip }, () => {
  const source = org(user());
  const install = installation(source, "shared-gh");
  // Shared into another org: that org isn't the source.
  const sharedTo = org(user());
  sql(`insert into org_github_installations (org_id, installation_id) values ('${sharedTo}', ${install})`);
  assert.equal(join(sharedTo, user(), "shared-gh", install), "not_source");

  assert.equal(join(source, user(), "someone-else", install), "not_source", "another GitHub organization's login");
  assert.equal(join(source, user(), "shared-gh", 999_999), "not_source", "an installation not recorded");

  const onUser = installation(org(user()), "a-person", { accountType: "User" });
  const userSource = sql(`select source_org_id from github_installations where installation_id = ${onUser}`);
  assert.equal(join(userSource, user(), "a-person", onUser), "not_source", "a user account's installation");

  const suspendedOrg = org(user());
  const suspended = installation(suspendedOrg, "paused", { suspended: true });
  assert.equal(join(suspendedOrg, user(), "paused", suspended), "not_source", "suspended");

  const leftOrg = org(user());
  const disconnected = installation(leftOrg, "gone");
  sql(`delete from org_github_installations where org_id = '${leftOrg}' and installation_id = ${disconnected}`);
  assert.equal(join(leftOrg, user(), "gone", disconnected), "not_source", "the source disconnected it");

  assert.equal(join(randomUUID(), user(), "shared-gh", install), "not_source", "no such org");
});

test("someone an admin removed can't let themselves back in; someone who left can", { skip }, () => {
  const admin = user();
  const team = org(admin);
  const install = installation(team, "comeback");

  const removed = user();
  sql(`insert into organization_removals (org_id, user_id, removed_by) values ('${team}', '${removed}', '${admin}')`);
  assert.equal(join(team, removed, "comeback", install), "removed");
  assert.equal(membership(team, removed), "");

  const left = user();
  sql(`insert into organization_removals (org_id, user_id, removed_by) values ('${team}', '${left}', '${left}')`);
  assert.equal(join(team, left, "comeback", install), "joined");
  assert.equal(sql(`select count(*) from organization_removals where org_id = '${team}' and user_id = '${left}'`), "0", "their sessions are theirs again");
});

test("the function is the server's alone", { skip }, () => {
  const fn = "join_org_via_github(uuid, uuid, text, bigint)";
  assert.equal(sql(`select has_function_privilege('authenticated', '${fn}', 'execute')`), "f");
  assert.equal(sql(`select has_function_privilege('anon', '${fn}', 'execute')`), "f");
  assert.equal(sql(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t");
  assert.throws(() => sql(`set role authenticated; select ${fn.replace(/\(.*/, "")}(gen_random_uuid(), gen_random_uuid(), 'x', 1)`), /permission denied/);
});
