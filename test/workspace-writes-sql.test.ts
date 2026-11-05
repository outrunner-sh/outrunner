/**
 * The workspace/runtime_computer write split (20261106100000), on a real
 * Postgres: the signed-in owner keeps their reads, their writes are refused
 * (the cross-tenant hole this closed: an owner could repoint
 * daytona_sandbox_id at another user's sandbox and open that box's desktop),
 * the service role keeps writing, and the box claims — still called by the
 * signed-in user — work as SECURITY DEFINER with their own auth.uid() checks.
 * The wake publisher is the server's alone, and states the row's owner.
 *
 * CI supplies the shared server (MISSIONS_PG, or WORKSPACE_WRITES_PG); locally
 * this is skipped without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.WORKSPACE_WRITES_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `workspace_writes_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const OWNER = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG = "00000000-0000-0000-0000-000000000012";
const PROJECT = "00000000-0000-0000-0000-000000000021";
const OTHER_PROJECT = "00000000-0000-0000-0000-000000000022";
const WORKSPACE = "00000000-0000-0000-0000-000000000031";
const OTHER_WORKSPACE = "00000000-0000-0000-0000-000000000032";
const POOLED_COMPUTER = "00000000-0000-0000-0000-000000000041";
let url = "";

function psql(target: string, sql: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function sql(text: string): string {
  return psql(url, text);
}

/**
 * One statement run as `role` signed in as `user`, in its own committed
 * transaction: the answer a PostgREST request of that user would get, its
 * writes left in place for what follows to see. A statement refused by the
 * database stops the script (ON_ERROR_STOP) before the commit, as an aborted
 * request would.
 */
function as(role: string, user: string, statement: string): string {
  return sql(`begin;
    set local role ${role};
    set local request.jwt.claim.sub = '${user}';
    ${statement};
    commit;`);
}

/** That the statement is refused, with the database's own words. */
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
  // The tables as 20261028120000_team_orgs.sql left them, on a plain
  // Postgres: both still carrying the `for all` policies this migration is
  // here to split, and anon/authenticated still holding Supabase's default
  // grants, which its revokes take the write half of.
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin%s', r, case when r = 'service_role' then ' bypassrls' else '' end);
      end if;
    end loop; end $$;
    create table organizations (id uuid primary key, personal_owner_id uuid);
    create table organization_members (org_id uuid, user_id uuid, role text, primary key (org_id, user_id));
    create function my_org_ids() returns setof uuid language sql stable security definer set search_path = '' as
      $$ select m.org_id from public.organization_members m where m.user_id = auth.uid() $$;
    create table projects (id uuid primary key, org_id uuid, owner_id uuid);
    create table workspaces (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null, org_id uuid, project_id uuid,
      status text not null default 'creating', title text, sandbox_id text
    );
    create table runtime_computers (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null, org_id uuid, project_id uuid,
      workspace_id uuid, pooled boolean not null default false, pool_slot integer not null default 0,
      generation integer, status text not null default 'provisioning', provider text,
      agent_secret text, image_version text, daytona_sandbox_id text, agent_base_url text,
      provision_timings jsonb, warm_expires_at timestamptz, warm_cleanup_pending boolean not null default false,
      error_message text, last_active_at timestamptz
    );
    create function check_org_box_cap(uuid, integer) returns void language plpgsql as $$ begin return; end $$;
    grant all on table workspaces, runtime_computers to anon, authenticated, service_role;
    alter table workspaces enable row level security;
    alter table runtime_computers enable row level security;
    create policy workspaces_owner_all on workspaces
      for all using (auth.uid() = owner_id and org_id in (select my_org_ids()));
    create policy runtime_computers_owner_all on runtime_computers
      for all using (auth.uid() = owner_id and org_id in (select my_org_ids()));
    insert into auth.users values ('${OWNER}'), ('${OTHER}');
    insert into organizations values ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER}');
    insert into organization_members values ('${ORG}', '${OWNER}', 'admin'), ('${OTHER_ORG}', '${OTHER}', 'admin');
    insert into projects values ('${PROJECT}', '${ORG}', '${OWNER}'), ('${OTHER_PROJECT}', '${OTHER_ORG}', '${OTHER}');
    insert into workspaces (id, owner_id, org_id, project_id, status, sandbox_id) values
      ('${WORKSPACE}', '${OWNER}', '${ORG}', '${PROJECT}', 'ready', 'sandbox-mine'),
      ('${OTHER_WORKSPACE}', '${OTHER}', '${OTHER_ORG}', '${OTHER_PROJECT}', 'ready', 'sandbox-theirs');
    insert into runtime_computers (
      id, owner_id, org_id, project_id, pooled, status, provider,
      daytona_sandbox_id, warm_cleanup_pending
    ) values (
      '${POOLED_COMPUTER}', '${OWNER}', '${ORG}', '${PROJECT}', true, 'stopped', 'daytona',
      'sandbox-pooled', false
    );
  `);
  sql(readFileSync("supabase/migrations/20261106100000_workspaces_server_writes.sql", "utf8"));
});

after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("SQL: the owner still reads their rows, and only theirs", { skip }, () => {
  assert.equal(as("authenticated", OWNER, `select sandbox_id from workspaces where id = '${WORKSPACE}'`), "sandbox-mine");
  assert.equal(as("authenticated", OWNER, `select daytona_sandbox_id from runtime_computers where id = '${POOLED_COMPUTER}'`), "sandbox-pooled");
  // The other user's row is invisible, not refused: RLS still guards reads.
  assert.equal(as("authenticated", OWNER, `select count(*) from workspaces where id = '${OTHER_WORKSPACE}'`), "0");
  assert.equal(as("authenticated", OWNER, `select count(*) from runtime_computers where owner_id = '${OTHER}'`), "0");
});

test("SQL: the owner can no longer write their own rows — the sandbox swap among them", { skip }, () => {
  for (const role of ["authenticated", "anon"]) {
    failsAs(role, OWNER, `update workspaces set sandbox_id = 'sandbox-stolen' where id = '${WORKSPACE}'`,
      /permission denied for table workspaces/);
    failsAs(role, OWNER, `insert into workspaces (owner_id, project_id) values ('${OWNER}', '${PROJECT}')`,
      /permission denied for table workspaces/);
    failsAs(role, OWNER, `delete from workspaces where id = '${WORKSPACE}'`,
      /permission denied for table workspaces/);
    failsAs(role, OWNER, `update runtime_computers set daytona_sandbox_id = 'sandbox-stolen' where id = '${POOLED_COMPUTER}'`,
      /permission denied for table runtime_computers/);
    failsAs(role, OWNER, `insert into runtime_computers (owner_id, project_id) values ('${OWNER}', '${PROJECT}')`,
      /permission denied for table runtime_computers/);
    failsAs(role, OWNER, `delete from runtime_computers where id = '${POOLED_COMPUTER}'`,
      /permission denied for table runtime_computers/);
  }
  // Nothing went through.
  assert.equal(sql(`select sandbox_id from workspaces where id = '${WORKSPACE}'`), "sandbox-mine");
  assert.equal(sql(`select daytona_sandbox_id from runtime_computers where id = '${POOLED_COMPUTER}'`), "sandbox-pooled");
});

test("SQL: the service role — the app's admin client — still writes", { skip }, () => {
  assert.equal(as("service_role", OWNER, `update workspaces set title = 'Renamed' where id = '${WORKSPACE}' returning title`), "Renamed");
  assert.equal(sql(`select title from workspaces where id = '${WORKSPACE}'`), "Renamed");
});

/** The pooled box back to a wake in flight, as intentWarmProject leaves it. */
function resetWake(): void {
  sql(`
    update runtime_computers
    set pooled = true, workspace_id = null, status = 'provisioning',
        daytona_sandbox_id = 'sandbox-pooled', agent_base_url = null,
        warm_expires_at = now() + interval '90 seconds', warm_cleanup_pending = false,
        error_message = null
    where id = '${POOLED_COMPUTER}'
  `);
}

test("SQL: the claims still work for the signed-in owner, and only for their own rows", { skip }, () => {
  // The pooled claim hands the owner their own pooled box, despite the
  // owner's lost grants: the claims are SECURITY DEFINER, their own
  // auth.uid() checks the whole authorization.
  assert.equal(
    as("authenticated", OWNER, `select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`),
    "sandbox-pooled",
  );
  // The workspace claim then takes that box over, stopped as it was, and
  // provisions it.
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`),
    "t",
  );
  assert.equal(
    sql(`select status from runtime_computers where workspace_id = '${WORKSPACE}'`),
    "provisioning",
  );
  // Someone else's workspace is not theirs to claim a box for, pooled or
  // not; their own workspace simply has no pooled box to take.
  failsAs("authenticated", OTHER, `select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`,
    /workspace not found/);
  failsAs("authenticated", OTHER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`,
    /workspace not found/);
  assert.equal(
    as("authenticated", OTHER, `select coalesce(claim_pooled_computer('${OTHER_WORKSPACE}', 'daytona', null), '')`),
    "",
  );
});

test("SQL: the wake pivot — claim your own row, then 'complete its wake' onto another's box — is shut", { skip }, () => {
  resetWake();
  // The attack this regression-tests: claim your own session's box (its row
  // goes to provisioning under your ownership), then "complete its wake"
  // with a victim's sandbox id. Both steps are the row's owner's to take —
  // so the RPC is not the owner's to call: no signed-in user may, whatever
  // row they name.
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`),
    "t",
  );
  failsAs("authenticated", OWNER, `select complete_pooled_warmup('${POOLED_COMPUTER}', '${OWNER}', 'sandbox-stolen', 'daytona', 'https://stolen.example', null)`,
    /permission denied for function complete_pooled_warmup/);
  // Nothing was written: the claimed row still records no box at all.
  assert.equal(
    sql(`select coalesce(daytona_sandbox_id, 'none') from runtime_computers where workspace_id = '${WORKSPACE}' and status = 'provisioning'`),
    "none",
  );
  assert.equal(sql(`select daytona_sandbox_id from runtime_computers where id = '${POOLED_COMPUTER}'`), "sandbox-pooled");
});

test("SQL: the server publishes a wake, naming the row's owner", { skip }, () => {
  resetWake();
  // A publish that names the wrong owner is a no-op, even from the server.
  assert.equal(
    as("service_role", OWNER, `select complete_pooled_warmup('${POOLED_COMPUTER}', '${OTHER}', 'sandbox-new', 'daytona', 'https://agent.new', null)`),
    "f",
  );
  assert.equal(
    sql(`select daytona_sandbox_id || ':' || coalesce(agent_base_url, '') from runtime_computers where id = '${POOLED_COMPUTER}'`),
    "sandbox-pooled:",
  );
  assert.equal(
    as("service_role", OWNER, `select complete_pooled_warmup('${POOLED_COMPUTER}', '${OWNER}', 'sandbox-new', 'daytona', 'https://agent.new', null)`),
    "t",
  );
  assert.equal(
    sql(`select status || ':' || agent_base_url from runtime_computers where id = '${POOLED_COMPUTER}'`),
    "ready:https://agent.new",
  );
});

test("SQL: a warmup claim stays on a project of the caller's org", { skip }, () => {
  // The definer claim no longer leans on RLS to hide other orgs' projects;
  // its own lookup must refuse them.
  failsAs("authenticated", OTHER, `select * from claim_pooled_warmup('${PROJECT}', 'daytona', null, null)`,
    /project not found/);
  // The owner's own project is theirs to warm.
  as("authenticated", OWNER, `select * from claim_pooled_warmup('${PROJECT}', 'daytona', null, null)`);
});
