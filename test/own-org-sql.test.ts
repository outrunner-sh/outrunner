/** A user's own org, and the one-Free-org cap on making more
 *  (20261120130000_own_org_on_sign_in.sql), on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const run = promisify(execFile);
const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `own_org_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
const asServer = (text: string) => sql(`set role service_role; ${text}`);

/** A fresh user's id. */
function user(): string {
  const id = randomUUID();
  sql(`insert into auth.users values ('${id}')`);
  return id;
}

const ownOrg = (id: string) => asServer(`select create_own_org('Own', '${id}')`);
const anotherOrg = (id: string, may: boolean) => asServer(`select create_team_org('Another', '${id}', null, ${may})`);
const orgsOf = (id: string) => Number(sql(`select count(*) from organization_members where user_id = '${id}'`));

/** The error psql gave, or "" when it ran. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? error);
  }
}

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
    -- The sign-up trigger as 20261027120000_organizations.sql made it.
    create function create_personal_org() returns trigger language plpgsql as $$
    declare org uuid;
    begin
      insert into public.organizations (name, personal_owner_id, created_by) values ('Personal', new.id, new.id) returning id into org;
      insert into public.organization_members (org_id, user_id, role) values (org, new.id, 'admin');
      return new;
    end $$;
    create trigger auth_users_create_personal_org after insert on auth.users
      for each row execute function create_personal_org();
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    -- Roles are the server's, shared with the other SQL tests running at
    -- once: altered only when they must be, or two alters collide.
    do $$ begin
      if not (select rolbypassrls from pg_roles where rolname = 'service_role') then alter role service_role bypassrls; end if;
    end $$;
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to service_role;
  `);
  for (const file of ["20261118120000_abandoned_org_domains.sql", "20261120130000_own_org_on_sign_in.sql"]) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("signing up makes no org: the app makes the user's own", { skip }, () => {
  assert.equal(orgsOf(user()), 0);
});

test("a user's own org is an ordinary org, theirs to admin, made once", { skip }, () => {
  const me = user();
  const org = ownOrg(me);
  assert.match(org, /^[0-9a-f-]{36}$/);
  assert.equal(sql(`select personal_owner_id is null and created_by = '${me}' from organizations where id = '${org}'`), "t");
  assert.equal(sql(`select role from organization_members where org_id = '${org}' and user_id = '${me}'`), "admin");
  // A second sign-in, or a second tab: none more.
  assert.equal(ownOrg(me), "");
  assert.equal(orgsOf(me), 1);
});

test("someone already in an org (an invite accepted first) gets no own org", { skip }, () => {
  const founder = user();
  const invited = user();
  const org = ownOrg(founder);
  sql(`insert into organization_members values ('${org}', '${invited}', 'member')`);
  assert.equal(ownOrg(invited), "");
  assert.equal(orgsOf(invited), 1);
});

test("two sign-ins at once make one own org", { skip }, async () => {
  const me = user();
  // Each holds its transaction open a moment after making it: without the
  // lock, the second would look before the first's insert is seen.
  const attempt = () =>
    run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
      `set role service_role; begin; select create_own_org('Own', '${me}'); select pg_sleep(0.3); commit;`]);
  await Promise.all([attempt(), attempt()]);
  assert.equal(orgsOf(me), 1);
});

test("one Free org per creator: their own counts; another takes the server's word", { skip }, () => {
  const me = user();
  ownOrg(me);
  assert.match(refusal(() => anotherOrg(me, false)), /one_free_org/);
  // The app from before this, while it's still serving, is capped the same.
  assert.match(refusal(() => asServer(`select create_team_org('Old', '${me}', null)`)), /one_free_org/);
  assert.equal(orgsOf(me), 1);
  assert.match(anotherOrg(me, true), /^[0-9a-f-]{36}$/);
  assert.equal(orgsOf(me), 2);
});

test("a personal org, or an org someone else made, doesn't count against the cap", { skip }, () => {
  const founder = user();
  const me = user();
  sql(`insert into organizations (name, personal_owner_id, created_by) values ('Personal', '${me}', '${me}')`);
  const theirs = ownOrg(founder);
  sql(`insert into organization_members values ('${theirs}', '${me}', 'member')`);
  assert.match(anotherOrg(me, false), /^[0-9a-f-]{36}$/);
});

test("two orgs made at once by one creator: only one gets through the cap", { skip }, async () => {
  const me = user();
  const attempt = () =>
    run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
      `set role service_role; begin; select create_team_org('Race', '${me}', null, false); select pg_sleep(0.3); commit;`])
      .then(() => "made", (error: { stderr?: string }) => (error.stderr?.includes("one_free_org") ? "refused" : String(error.stderr)));
  assert.deepEqual((await Promise.all([attempt(), attempt()])).sort(), ["made", "refused"]);
  assert.equal(orgsOf(me), 1);
});

test("only the server makes orgs", { skip }, () => {
  for (const fn of ["create_own_org(text, uuid)", "create_team_org(text, uuid, text, boolean)", "lock_org_making(uuid)"]) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(sql(`select has_function_privilege('${role}', '${fn}', 'execute')`), "f", `${role} ${fn}`);
    }
  }
});
