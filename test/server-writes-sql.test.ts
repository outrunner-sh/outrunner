/**
 * pull_requests and the box claims made the server's alone (20261112110000,
 * 20261112120000), on a real Postgres:
 *
 * - A signed-in owner still reads their pull requests but can't write them
 *   (they could forge project_id/github_number through REST), and project_id
 *   must name a project.
 * - The claims and the box cap can't be called by a signed-in user (who could
 *   pass no cap and their own agent secret); the server names the user, and
 *   membership of the org is checked whatever the cap.
 *
 * CI supplies the shared server (MISSIONS_PG, or SERVER_WRITES_PG); locally
 * this is skipped without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.SERVER_WRITES_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `server_writes_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const OWNER = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG = "00000000-0000-0000-0000-000000000012";
const PROJECT = "00000000-0000-0000-0000-000000000021";
const SECOND_PROJECT = "00000000-0000-0000-0000-000000000022";
const WORKSPACE = "00000000-0000-0000-0000-000000000031";
const SECOND_WORKSPACE = "00000000-0000-0000-0000-000000000032";
const PULL = "00000000-0000-0000-0000-000000000051";
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}

const sql = (text: string) => psql(url, text);

/** One statement as `role`, signed in as `user`, committed as a request would be. */
function as(role: string, user: string, statement: string): string {
  return sql(`begin;
    set local role ${role};
    set local request.jwt.claim.sub = '${user}';
    ${statement};
    commit;`);
}

function failsAs(role: string, user: string, statement: string, pattern: RegExp) {
  assert.throws(
    () => as(role, user, statement),
    (error: { stderr?: string }) => pattern.test(String(error.stderr)),
  );
}

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const target = new URL(server);
  target.pathname = `/${name}`;
  url = target.toString();
  // The tables as production has them before these migrations, on a plain
  // Postgres with Supabase's default grants to anon and authenticated.
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to public;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin%s', r, case when r = 'service_role' then ' bypassrls' else '' end);
      end if;
    end loop; end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create table organizations (id uuid primary key);
    create table organization_members (org_id uuid, user_id uuid, role text, primary key (org_id, user_id));
    create function my_org_ids() returns setof uuid language sql stable security definer set search_path = '' as
      $$ select m.org_id from public.organization_members m where m.user_id = auth.uid() $$;
    create table org_connectors (org_id uuid, user_id uuid);
    create table projects (id uuid primary key, org_id uuid, owner_id uuid);
    create table workspaces (
      id uuid primary key, owner_id uuid not null, org_id uuid, project_id uuid,
      status text not null default 'ready', unique (owner_id, id)
    );
    create table runtime_computers (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null, org_id uuid, project_id uuid,
      workspace_id uuid, pooled boolean not null default false, pool_slot integer not null default 0,
      generation integer, status text not null default 'provisioning', provider text,
      agent_secret text, image_version text, daytona_sandbox_id text, agent_base_url text,
      provision_timings jsonb, warm_expires_at timestamptz, warm_cleanup_pending boolean not null default false,
      error_message text, last_active_at timestamptz, updated_at timestamptz not null default now()
    );
    -- The org of a box, as production's trigger fills it in.
    create function runtime_computers_org() returns trigger language plpgsql as $$
    begin
      if new.org_id is null then select org_id into new.org_id from projects where id = new.project_id; end if;
      return new;
    end $$;
    create trigger runtime_computers_org before insert on runtime_computers
      for each row execute function runtime_computers_org();
    create function live_metered_computers(for_owner uuid) returns bigint language sql stable as
      $$ select count(*) from runtime_computers where owner_id = for_owner and not pooled and status in ('ready', 'provisioning') $$;
    create function live_org_computers(for_org uuid) returns bigint language sql stable security definer as
      $$ select count(*) from runtime_computers where org_id = for_org and not pooled and status in ('ready', 'provisioning') $$;
    create table pull_requests (
      id uuid primary key default gen_random_uuid(),
      owner_id uuid not null,
      workspace_id uuid not null,
      project_id uuid not null,
      github_number integer not null,
      url text not null default '',
      title text not null default '',
      base_branch text not null default 'main',
      head_branch text not null,
      created_at timestamptz not null default now(),
      constraint pull_requests_owner_workspace_fkey foreign key (owner_id, workspace_id)
        references workspaces (owner_id, id) on delete cascade
    );
    -- 20261112100000 indexes it.
    create table compute_intervals (
      id uuid primary key default gen_random_uuid(), computer_id uuid, sandbox_id text, started_at timestamptz not null default now()
    );
    alter table pull_requests enable row level security;
    create policy pull_requests_owner_all on pull_requests
      for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    alter table workspaces enable row level security;
    alter table runtime_computers enable row level security;
    create policy workspaces_owner_all on workspaces
      for all using (auth.uid() = owner_id and org_id in (select my_org_ids()));
    create policy runtime_computers_owner_all on runtime_computers
      for all using (auth.uid() = owner_id and org_id in (select my_org_ids()));
    grant all on all tables in schema public to anon, authenticated, service_role;

    insert into auth.users values ('${OWNER}'), ('${OTHER}');
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    insert into organization_members values ('${ORG}', '${OWNER}', 'admin'), ('${OTHER_ORG}', '${OTHER}', 'admin');
    insert into projects values ('${PROJECT}', '${ORG}', '${OWNER}'), ('${SECOND_PROJECT}', '${ORG}', '${OWNER}');
    insert into workspaces (id, owner_id, org_id, project_id) values
      ('${WORKSPACE}', '${OWNER}', '${ORG}', '${PROJECT}'),
      ('${SECOND_WORKSPACE}', '${OWNER}', '${ORG}', '${SECOND_PROJECT}');
    insert into pull_requests (id, owner_id, workspace_id, project_id, github_number, head_branch)
      values ('${PULL}', '${OWNER}', '${WORKSPACE}', '${PROJECT}', 7, 'feature');
  `);
  // As production has them: the claims of 20261106100000 and 20261112100000, then these two.
  for (const file of [
    "20261106100000_workspaces_server_writes.sql",
    "20261112100000_claim_keeps_ended_box.sql",
    "20261112110000_pull_requests_server_writes.sql",
    "20261112120000_server_box_claims.sql",
  ]) {
    sql(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
});

after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("SQL: the owner reads their pull requests, and only theirs", { skip }, () => {
  assert.equal(as("authenticated", OWNER, `select github_number from pull_requests where id = '${PULL}'`), "7");
  assert.equal(as("authenticated", OTHER, "select count(*) from pull_requests"), "0");
  assert.throws(() => as("anon", OWNER, "select count(*) from pull_requests"), /permission denied/);
});

test("SQL: no signed-in user writes pull_requests through REST, not even their own rows", { skip }, () => {
  for (const role of ["authenticated", "anon"]) {
    failsAs(role, OWNER, `update pull_requests set github_number = 99, project_id = '${SECOND_PROJECT}' where id = '${PULL}'`,
      /permission denied for table pull_requests/);
    failsAs(role, OWNER, `insert into pull_requests (owner_id, workspace_id, project_id, github_number, head_branch)
      values ('${OWNER}', '${WORKSPACE}', '${SECOND_PROJECT}', 99, 'feature')`, /permission denied for table pull_requests/);
    failsAs(role, OWNER, `delete from pull_requests where id = '${PULL}'`, /permission denied for table pull_requests/);
  }
  assert.equal(sql(`select github_number || ':' || project_id from pull_requests where id = '${PULL}'`), `7:${PROJECT}`);
  assert.equal(sql("select count(*) from pg_policy where polrelid = 'pull_requests'::regclass and polcmd <> 'r'"), "0");
});

test("SQL: the server writes pull_requests, and project_id must name a project", { skip }, () => {
  assert.equal(
    as("service_role", OWNER, `insert into pull_requests (owner_id, workspace_id, project_id, github_number, head_branch)
      values ('${OWNER}', '${SECOND_WORKSPACE}', '${SECOND_PROJECT}', 8, 'other') returning github_number`),
    "8",
  );
  assert.throws(
    () => as("service_role", OWNER, `insert into pull_requests (owner_id, workspace_id, project_id, github_number, head_branch)
      values ('${OWNER}', '${WORKSPACE}', '${randomUUID()}', 9, 'feature')`),
    /pull_requests_project_id_fkey/,
  );
  // A project's pull requests go with it.
  sql(`delete from projects where id = '${SECOND_PROJECT}'`);
  assert.equal(sql(`select count(*) from pull_requests where project_id = '${SECOND_PROJECT}'`), "0");
});

test("SQL: no signed-in user calls a claim or the box cap; the server does", { skip }, () => {
  for (const signature of [
    "claim_workspace_computer(uuid, uuid, text, text, integer)",
    "claim_runtime_computer(uuid, uuid, text, text, integer)",
    "claim_pooled_computer(uuid, uuid, text, integer)",
    "claim_pooled_warmup(uuid, uuid, text, integer, integer)",
    "check_org_box_cap(uuid, uuid, integer)",
  ]) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(sql(`select has_function_privilege('${role}', '${signature}', 'execute')`), "f", `${role}: ${signature}`);
    }
    assert.equal(sql(`select has_function_privilege('service_role', '${signature}', 'execute')`), "t", signature);
  }
  // No overload of the old, caller-trusting claims is left.
  assert.equal(sql(`
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('claim_workspace_computer', 'claim_runtime_computer', 'claim_pooled_computer', 'claim_pooled_warmup', 'check_org_box_cap')
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
  `), "0");
  failsAs("authenticated", OWNER, `select * from claim_workspace_computer('${OWNER}', '${WORKSPACE}', 's', 'v1', null)`,
    /permission denied for function claim_workspace_computer/);
});

test("SQL: the server's claim is for the user it names, in an org they're still a member of, whatever the cap", { skip }, () => {
  // Another user can't be named onto the owner's session.
  failsAs("service_role", OWNER, `select * from claim_workspace_computer('${OTHER}', '${WORKSPACE}', 's', 'v1', null)`,
    /workspace not found/);
  // A member, uncapped: a box.
  assert.equal(
    as("service_role", OWNER, `select should_provision from claim_workspace_computer('${OWNER}', '${WORKSPACE}', 's', 'v1', null)`),
    "t",
  );
  // Removed from the org, they keep owning the session, but no box comes of
  // it: not with no cap (the early return that skipped membership), nor
  // with one, nor pooled or warmed.
  sql(`update runtime_computers set status = 'stopped' where workspace_id = '${WORKSPACE}';
       delete from organization_members where org_id = '${ORG}' and user_id = '${OWNER}'`);
  failsAs("service_role", OWNER, `select * from claim_workspace_computer('${OWNER}', '${WORKSPACE}', 's', 'v1', null)`, /org not found/);
  failsAs("service_role", OWNER, `select * from claim_workspace_computer('${OWNER}', '${WORKSPACE}', 's', 'v1', 5)`, /org not found/);
  failsAs("service_role", OWNER, `select * from claim_runtime_computer('${OWNER}', '${PROJECT}', 's', 'v1', null)`, /org not found/);
  failsAs("service_role", OWNER, `select check_org_box_cap('${ORG}', '${OWNER}', null)`, /org not found/);
  failsAs("service_role", OWNER, `select * from claim_pooled_warmup('${OWNER}', '${PROJECT}', 'daytona', null, null)`, /project not found/);
  sql(`insert into workspaces (id, owner_id, org_id, project_id) values ('${randomUUID()}', '${OWNER}', '${ORG}', '${PROJECT}')`);
  failsAs("service_role", OWNER,
    `select claim_pooled_computer('${OWNER}', (select id from workspaces where id <> '${WORKSPACE}' and project_id = '${PROJECT}' limit 1), 'daytona', null)`,
    /org not found/);
  // A user of another org can't check this one's cap either.
  failsAs("service_role", OTHER, `select check_org_box_cap('${ORG}', '${OTHER}', null)`, /org not found/);
  // Back in the org, the cap holds.
  sql(`insert into organization_members values ('${ORG}', '${OWNER}', 'admin');
       update runtime_computers set status = 'ready' where workspace_id = '${WORKSPACE}'`);
  assert.throws(
    () => as("service_role", OWNER, `select check_org_box_cap('${ORG}', '${OWNER}', 1)`),
    /concurrent cloud sessions/,
  );
  as("service_role", OWNER, `select check_org_box_cap('${ORG}', '${OWNER}', 2)`);
});

test("SQL: the server's claim on an ended box still names that box (20261112100000 kept)", { skip }, () => {
  for (const status of ["stopped", "error"]) {
    sql(`update runtime_computers set status = '${status}', daytona_sandbox_id = 'box-kept' where workspace_id = '${WORKSPACE}'`);
    assert.equal(
      as("service_role", OWNER, `select should_provision from claim_workspace_computer('${OWNER}', '${WORKSPACE}', 's', 'v1', null)`),
      "t",
    );
    assert.equal(sql(`select status || ':' || coalesce(daytona_sandbox_id, '-') from runtime_computers where workspace_id = '${WORKSPACE}'`), "provisioning:box-kept");
  }
  sql(`update runtime_computers set status = 'ready' where workspace_id = '${WORKSPACE}'`);
});
