/** A domain held by an org with no people left
 *  (20261118120000_abandoned_org_domains.sql) on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `abandoned_org_domains_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

/** A team org made as the server makes one; its id. */
const makeOrg = (orgName: string, creator: string, domain: string) =>
  sql(`set role service_role; select create_team_org('${orgName}', '${creator}', '${domain}')`);

/** The orgs someone from `domain` is pointed at, as `name:people`. */
const domainOrgs = (domain: string) =>
  sql(`set role service_role; select string_agg(name || ':' || member_count, ',') from domain_orgs(array['${domain}'])`);

const claimant = (domain: string) => sql(`select org_id from organization_domains where domain = '${domain}'`);

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
      created_by uuid references auth.users (id) on delete set null, personal_owner_id uuid
    );
    create table organization_members (
      org_id uuid references organizations (id) on delete cascade,
      user_id uuid references auth.users (id) on delete cascade,
      role text, primary key (org_id, user_id)
    );
    create table organization_domains (
      domain text primary key, org_id uuid not null references organizations (id) on delete cascade,
      claimed_by uuid references auth.users (id) on delete set null
    );
    create table org_connectors (
      org_id uuid primary key references organizations (id) on delete cascade,
      user_id uuid not null unique references auth.users (id) on delete cascade
    );
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    alter role service_role bypassrls;
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to service_role;
  `);
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261118120000_abandoned_org_domains.sql"], {
    stdio: "pipe",
  });
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("an org with people keeps its domain: it's the one pointed at, and another is refused", { skip }, () => {
  const founder = user();
  const org = makeOrg("Acme", founder, "acme.dev");
  assert.equal(domainOrgs("acme.dev"), "Acme:1");
  assert.throws(() => makeOrg("Acme Two", user(), "acme.dev"), /organization_domains_pkey/);
  assert.equal(claimant("acme.dev"), org);
});

test("its people's accounts deleted, an org holds its domain for no one: the next org takes it", { skip }, () => {
  const founder = user();
  const abandoned = makeOrg("walkover", founder, "whozzat.com");
  sql(`delete from auth.users where id = '${founder}'`);
  assert.equal(domainOrgs("whozzat.com"), "");

  const next = makeOrg("Whozzat", user(), "whozzat.com");
  assert.equal(claimant("whozzat.com"), next);
  assert.equal(domainOrgs("whozzat.com"), "Whozzat:1");
  // The abandoned org itself is left alone; only its claim moved.
  assert.equal(sql(`select count(*) from organizations where id = '${abandoned}'`), "1");
});

test("an org left with only its connector counts as having no people", { skip }, () => {
  const founder = user();
  const org = makeOrg("Botco", founder, "botco.io");
  const connector = user();
  sql(`insert into organization_members values ('${org}', '${connector}', 'admin'); insert into org_connectors values ('${org}', '${connector}')`);
  assert.equal(domainOrgs("botco.io"), "Botco:1");

  sql(`delete from auth.users where id = '${founder}'`);
  assert.equal(domainOrgs("botco.io"), "");
  const next = makeOrg("Botco Again", user(), "botco.io");
  assert.equal(claimant("botco.io"), next);
});

test("the new functions are the server's alone", { skip }, () => {
  for (const fn of ["org_people(uuid)", "domain_orgs(text[])", "create_team_org(text, uuid, text)"]) {
    assert.equal(sql(`select has_function_privilege('authenticated', '${fn}', 'execute')`), "f", fn);
    assert.equal(sql(`select has_function_privilege('anon', '${fn}', 'execute')`), "f", fn);
    assert.equal(sql(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t", fn);
  }
});
