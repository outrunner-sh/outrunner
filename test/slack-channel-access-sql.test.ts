/** Real migration checks on a disposable database. CI supplies MISSIONS_PG. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";

const server = process.env.SLACK_CHANNEL_ACCESS_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `slack_access_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";
const ADMIN = "00000000-0000-0000-0000-000000000001";
const MEMBER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG = "00000000-0000-0000-0000-000000000012";
const WEB = "00000000-0000-0000-0000-000000000021";
const API = "00000000-0000-0000-0000-000000000022";
function psql(target: string, sql: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
function fails(text: string, pattern: RegExp) {
  assert.throws(() => sql(text), (error: { stderr?: string }) => pattern.test(String(error.stderr)));
}
function share(channel: string, ids = [WEB], actor = ADMIN, org = ORG) {
  return `select set_slack_channel_access('T1', '${channel}', '${org}', '${actor}', array[${ids.map((id) => `'${id}'::uuid`).join(",")}]::uuid[], 'U_ACTUAL')`;
}
before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server); u.pathname = `/${name}`; url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table organizations (id uuid primary key);
    create table organization_members (org_id uuid, user_id uuid, role text, primary key(org_id, user_id));
    create table projects (id uuid primary key, org_id uuid);
    create table slack_conversations (id uuid primary key);
    create table work_items (id uuid primary key, created_at timestamptz, status text);
    create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    insert into auth.users values ('${ADMIN}'), ('${MEMBER}');
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    insert into organization_members values ('${ORG}', '${ADMIN}', 'admin'), ('${ORG}', '${MEMBER}', 'member'), ('${OTHER_ORG}', '${ADMIN}', 'admin');
    insert into projects values ('${WEB}', '${ORG}'), ('${API}', '${OTHER_ORG}');
  `);
  for (const file of ["20261031170000_slack_proactive.sql", "20261101115000_audit_events.sql", "20261103180000_slack_channel_access.sql"]) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
});
after(() => { if (server) psql(server, `drop database if exists ${name} with (force)`); });

test("SQL: admin grant records exact repositories and actual Slack sender atomically", { skip }, () => {
  sql(share("C_GRANT"));
  assert.equal(sql("select shared_projects::text from slack_channels where channel_id = 'C_GRANT'"), `{${WEB}}`);
  const audit = JSON.parse(sql("select row_to_json(a) from audit_events a where resource_id = 'T1/C_GRANT'"));
  assert.equal(audit.actor_id, null);
  assert.equal(audit.actor_label, "Slack T1/U_ACTUAL");
  assert.equal(audit.action, "slack_channel.shared");
  assert.equal(audit.details.slack_user_id, "U_ACTUAL");
  assert.equal(audit.details.authorized_by, ADMIN);
  assert.deepEqual(audit.details.project_ids, [WEB]);
  const revision = sql("select shared_revision from slack_channels where channel_id = 'C_GRANT'");
  sql(share("C_GRANT"));
  assert.notEqual(sql("select shared_revision from slack_channels where channel_id = 'C_GRANT'"), revision);
});

test("SQL: members and cross-org projects cannot grant; a channel cannot be rebound through settings", { skip }, () => {
  fails(share("C_MEMBER", [WEB], MEMBER), /Only an organization admin/);
  fails(share("C_WRONG_PROJECT", [API]), /repository is not in this organization/);
  sql(share("C_BOUND"));
  fails(share("C_BOUND", [API], ADMIN, OTHER_ORG), /already configured for another organization/);
  fails(`update slack_channels set org_id = '${OTHER_ORG}' where channel_id = 'C_BOUND'`, /already configured for another organization/);
  assert.equal(sql("select org_id from slack_channels where channel_id = 'C_BOUND'"), ORG);
});

test("SQL: explicit revocation clears authorization and keeps existing digest/watch settings", { skip }, () => {
  sql(share("C_REVOKE"));
  sql("update slack_channels set digest = 'weekly', watch = true where channel_id = 'C_REVOKE'");
  sql(share("C_REVOKE", []));
  assert.equal(sql("select shared_by is null and shared_revision is null and cardinality(shared_projects) = 0 and watch and digest = 'weekly' from slack_channels where channel_id = 'C_REVOKE'"), "t");
  assert.equal(sql("select count(*) from audit_events where resource_id = 'T1/C_REVOKE' and action = 'slack_channel.revoked'"), "1");
});

test("SQL: admin demotion and removal revoke permanently, without affecting another org", { skip }, () => {
  sql(share("C_DEMOTE"));
  sql(share("C_OTHER", [API], ADMIN, OTHER_ORG));
  sql(`update organization_members set role = 'member' where org_id = '${ORG}' and user_id = '${ADMIN}'`);
  assert.equal(sql("select shared_revision is null from slack_channels where channel_id = 'C_DEMOTE'"), "t");
  assert.equal(sql("select shared_revision is not null from slack_channels where channel_id = 'C_OTHER'"), "t");
  sql(`update organization_members set role = 'admin' where org_id = '${ORG}' and user_id = '${ADMIN}'`);
  assert.equal(sql("select shared_revision is null from slack_channels where channel_id = 'C_DEMOTE'"), "t");
  sql(share("C_REMOVE"));
  sql(`delete from organization_members where org_id = '${ORG}' and user_id = '${ADMIN}'`);
  sql(`insert into organization_members values ('${ORG}', '${ADMIN}', 'admin')`);
  assert.equal(sql("select shared_revision is null from slack_channels where channel_id = 'C_REMOVE'"), "t");
});

test("SQL: anonymous and authenticated clients cannot invoke the grant RPC or access channel rows", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    fails(`set role ${role}; ${share("C_CLIENT")}`, /permission denied for function/);
    fails(`set role ${role}; select * from slack_channels`, /permission denied/);
  }
  assert.equal(sql("select has_function_privilege('service_role', 'set_slack_channel_access(text,text,uuid,uuid,uuid[],text)', 'execute')"), "t");
});

test("SQL: audit failure rolls the grant back", { skip }, () => {
  // Oversized sender violates audit_events.actor_label's bound after the upsert.
  fails(share("C_NO_AUDIT").replace("U_ACTUAL", "U".repeat(300)), /check constraint/);
  assert.equal(sql("select count(*) from slack_channels where channel_id = 'C_NO_AUDIT'"), "0");
});

test("SQL: demotion racing an uncommitted grant revokes it after commit", { skip }, async () => {
  const grant = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
    `begin; ${share("C_RACING")}; select 'grant-held'; select pg_sleep(1); commit`]);
  const grantDone = once(grant, "close");
  await new Promise<void>((resolve, reject) => {
    let output = "";
    grant.stdout.on("data", (chunk) => { output += chunk; if (output.includes("grant-held")) resolve(); });
    grant.on("error", reject);
    grant.on("close", (code) => { if (!output.includes("grant-held")) reject(new Error(`grant exited ${code}`)); });
  });
  // This UPDATE must wait for the grant's member-row lock, then revoke the
  // newly committed row. Without the lock its trigger sees no grant yet.
  const demote = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
    `update organization_members set role = 'member' where org_id = '${ORG}' and user_id = '${ADMIN}'`]);
  const [granted, demoted] = await Promise.all([grantDone, once(demote, "close")]);
  assert.equal(granted[0], 0);
  assert.equal(demoted[0], 0);
  assert.equal(sql("select shared_revision is null from slack_channels where channel_id = 'C_RACING'"), "t");
  sql(`update organization_members set role = 'admin' where org_id = '${ORG}' and user_id = '${ADMIN}'`);
});
