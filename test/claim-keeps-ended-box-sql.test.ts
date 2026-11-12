/**
 * The box claims keep naming the box that ended (20261112100000), on a real
 * Postgres. Claiming a stopped box to bring it back used to clear its
 * daytona_sandbox_id, the request doing it writing the id back in a second
 * statement: a deploy that cut the request off between the two (prod,
 * 2026-11-12) left the row provisioning and naming no box, the session
 * unopenable, and the paused box, its files on it, for the orphan sweep to
 * delete. Now the row names the box from the claim on.
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
const name = `claim_keeps_box_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
    -- The 5-arg complete_pooled_warmup this migration must retire. On a clean
    -- chain it arrives an invoker from 20261103210000; on a database that ran
    -- the first draft of this migration it survived as a SECURITY DEFINER
    -- twin, granted to authenticated, the pivot still open through it. Seeded
    -- here at its worst: whatever it is, the migration must drop it.
    create function complete_pooled_warmup(
      requested_computer_id uuid, requested_sandbox_id text, requested_provider text,
      requested_agent_base_url text, requested_timings jsonb)
    returns boolean language plpgsql security definer set search_path = public, pg_temp as
    $$ begin return true; end $$;
    grant execute on function complete_pooled_warmup(uuid, text, text, text, jsonb) to authenticated;
  `);
    sql(readFileSync("supabase/migrations/20261106100000_workspaces_server_writes.sql", "utf8"));
  sql(`create table compute_intervals (
    id uuid primary key default gen_random_uuid(), computer_id uuid, sandbox_id text, started_at timestamptz not null default now()
  )`);
  sql(readFileSync("supabase/migrations/20261112100000_claim_keeps_ended_box.sql", "utf8"));
});

after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("SQL: claiming a session's paused box to bring it back keeps naming that box", { skip }, () => {
  sql(`delete from runtime_computers where workspace_id = '${WORKSPACE}';
    insert into runtime_computers (owner_id, org_id, project_id, workspace_id, status, provider, daytona_sandbox_id, agent_base_url)
    values ('${OWNER}', '${ORG}', '${PROJECT}', '${WORKSPACE}', 'stopped', 'daytona', 'box-paused', 'https://old.example')`);
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`),
    "t",
  );
  // Cut off here, the row still says which box holds the session.
  assert.equal(
    sql(`select status || ' ' || coalesce(daytona_sandbox_id, 'none') || ' ' || coalesce(agent_base_url, 'none')
      from runtime_computers where workspace_id = '${WORKSPACE}'`),
    "provisioning box-paused none",
  );
  // A second open waits on the claim rather than taking it over again.
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`),
    "f",
  );
});

test("SQL: a failed box claimed again keeps naming its box too", { skip }, () => {
  sql(`update runtime_computers set status = 'error' where workspace_id = '${WORKSPACE}'`);
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`),
    "t",
  );
  assert.equal(sql(`select daytona_sandbox_id from runtime_computers where workspace_id = '${WORKSPACE}'`), "box-paused");
});

test("SQL: a project's shared box from before keeps naming its box when claimed", { skip }, () => {
  sql(`insert into runtime_computers (owner_id, org_id, project_id, status, provider, daytona_sandbox_id)
    values ('${OWNER}', '${ORG}', '${PROJECT}', 'stopped', 'daytona', 'box-shared')`);
  assert.equal(
    as("authenticated", OWNER, `select should_provision from claim_runtime_computer('${PROJECT}', 'secret', null, null)`),
    "t",
  );
  assert.equal(
    sql(`select status || ' ' || daytona_sandbox_id from runtime_computers where project_id = '${PROJECT}' and workspace_id is null and not pooled`),
    "provisioning box-shared",
  );
});

test("SQL: the claims still refuse another user's session or project", { skip }, () => {
  failsAs("authenticated", OTHER, `select should_provision from claim_workspace_computer('${WORKSPACE}', 'secret', null, null)`,
    /workspace not found/);
  failsAs("authenticated", OTHER, `select should_provision from claim_runtime_computer('${PROJECT}', 'secret', null, null)`,
    /project not found/);
});

test("SQL: a computer's newest box is read by index, not by scanning every interval", { skip }, () => {
  assert.equal(
    sql(`select indexdef from pg_indexes where indexname = 'compute_intervals_computer_started_idx'`),
    "CREATE INDEX compute_intervals_computer_started_idx ON public.compute_intervals USING btree (computer_id, started_at DESC)",
  );
});
