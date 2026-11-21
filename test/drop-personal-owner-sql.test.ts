/** personal_owner_id gone, and what named it rewritten
 *  (20261121100000_drop_personal_owner.sql), on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `drop_personal_owner_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
const asServer = (text: string) => sql(`set role service_role; ${text}`);

function user(): string {
  const id = randomUUID();
  sql(`insert into auth.users values ('${id}', '${id}@example.com')`);
  return id;
}

/** An org `creator` made, them its admin: a former personal org is one. */
function org(creator: string): string {
  const id = sql(`insert into organizations (name, created_by) values ('Own', '${creator}') returning id`);
  sql(`insert into organization_members (org_id, user_id, role) values ('${id}', '${creator}', 'admin')`);
  return id;
}

/** An installation on GitHub organization `login`, `source`'s, linked to it. */
function installation(source: string, login: string): number {
  const id = Math.floor(Math.random() * 1e9);
  sql(`insert into github_installations values (${id}, '${login}', 'Organization', null, '${source}');
       insert into org_github_installations (org_id, installation_id) values ('${source}', ${id})`);
  return id;
}

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table organizations (
      id uuid primary key default gen_random_uuid(), name text not null,
      created_by uuid references auth.users (id) on delete set null,
      personal_owner_id uuid unique references auth.users (id) on delete cascade
    );
    create table organization_members (
      org_id uuid references organizations (id) on delete cascade,
      user_id uuid references auth.users (id) on delete cascade,
      role text not null, joined_via_github text, primary key (org_id, user_id)
    );
    create table organization_removals (
      org_id uuid references organizations (id) on delete cascade, user_id uuid, removed_by uuid,
      primary key (org_id, user_id)
    );
    create table organization_settings (org_id uuid primary key references organizations (id) on delete cascade, join_via_github boolean);
    create table organization_domains (domain text primary key, org_id uuid references organizations (id) on delete cascade, claimed_by uuid);
    create table github_installations (
      installation_id bigint primary key, account_login text not null, account_type text not null,
      suspended_at timestamptz, source_org_id uuid references organizations (id) on delete set null
    );
    create table org_github_installations (
      org_id uuid references organizations (id) on delete cascade,
      installation_id bigint references github_installations (installation_id) on delete cascade,
      installed_by uuid, authority text, created_at timestamptz not null default now(),
      primary key (org_id, installation_id)
    );
    create function github_installation_source(target_installation bigint) returns uuid language sql stable as $f$
      select source_org_id from github_installations where installation_id = target_installation
    $f$;
    create function org_people(target_org uuid) returns bigint language sql stable as $f$
      select count(*) from organization_members where org_id = target_org
    $f$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    -- Roles are shared with the other SQL tests running at once: altered only
    -- when they must be.
    do $$ begin
      if not (select rolbypassrls from pg_roles where rolname = 'service_role') then alter role service_role bypassrls; end if;
    end $$;
    grant usage on schema public to authenticated, service_role;
    grant usage on schema auth to service_role;
    grant all on all tables in schema public, auth to service_role;
  `);
  for (const file of ["20261120130000_own_org_on_sign_in.sql", "20261121100000_drop_personal_owner.sql"]) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("no org can be anyone's personal org: the column is gone", { skip }, () => {
  assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'organizations' and column_name = 'personal_owner_id'`), "0");
});

test("members of its GitHub organization join a user's own org as any other", { skip }, () => {
  const owner = user();
  const own = org(owner);
  const install = installation(own, "acme");
  const joiner = user();
  assert.equal(asServer(`select join_org_via_github('${own}', '${joiner}', 'acme', ${install})`), "joined");
  assert.equal(asServer(`select join_org_via_github('${own}', '${joiner}', 'acme', ${install})`), "member");
  assert.equal(asServer(`select join_org_via_github('${randomUUID()}', '${joiner}', 'acme', ${install})`), "not_source");
  sql(`insert into organization_settings values ('${own}', false)`);
  assert.equal(asServer(`select join_org_via_github('${own}', '${user()}', 'acme', ${install})`), "disabled");
});

test("an installation's shares are listed without saying whose own an org is", { skip }, () => {
  const source = org(user());
  const other = org(user());
  const install = installation(source, "initech");
  sql(`insert into org_github_installations (org_id, installation_id) values ('${other}', ${install})`);
  assert.equal(asServer(`select org_id from github_installation_shares('${source}', ${install})`), other);
  assert.equal(
    sql(`select array_to_string(proargnames, ',') from pg_proc where proname = 'github_installation_shares'`),
    "source_org,target_installation,org_id,org_name,linked_at,linked_by,linked_by_email,authority",
  );
  assert.equal(sql(`select has_function_privilege('authenticated', 'github_installation_shares(uuid, bigint)', 'execute')`), "f");
});

test("every org a creator made counts against their one Free org, their former personal one too", { skip }, () => {
  const creator = user();
  org(creator);
  assert.throws(() => asServer(`select create_team_org('Second', '${creator}', null, false)`), /one_free_org/);
  assert.match(asServer(`select create_team_org('Second', '${creator}', null, true)`), /^[0-9a-f-]{36}$/);
});
