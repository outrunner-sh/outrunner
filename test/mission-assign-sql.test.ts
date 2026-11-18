/**
 * The `!assign` / `!new` migration's SQL (20261118120300_mission_assign.sql),
 * run on a real Postgres after the Missions migrations before it: the
 * assignee columns, and unannounced_new_requests, the predicate the tick's
 * unannouncedRequests (lib/missions/slack-store.ts) calls by RPC, so this is
 * the query itself, not a copy of it. Needs MISSIONS_PG, as
 * test/mission-slack-sql.test.ts does; skipped without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";

let url = "";
const name = `mission_assign_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

before(() => {
  if (!server) return;
  execFileSync("psql", [server, "-qc", `create database ${name}`]);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "test/sql/missions-stub.sql"]);
  for (const file of readdirSync("supabase/migrations").filter((f) => f >= "20261102200000" && f.includes("mission")).sort()) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`]);
  }
});

after(() => {
  if (server) execFileSync("psql", [server, "-qc", `drop database if exists ${name} with (force)`]);
});

const OWNER = "00000000-0000-0000-0000-00000000000a";

function mission(): string {
  return psql(`insert into workspaces (owner_id, kind, status) values ('${OWNER}', 'mission', 'ready') returning id`);
}

function thread(missionId: string, ts: string): string {
  return psql(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${missionId}', 'T1', 'C100', '${ts}') returning id`);
}

/** The keys the tick would be handed, oldest first. */
function untold(before = "now() + interval '1 minute'", max = 25): string[] {
  const out = psql(`select request_key from unannounced_new_requests(${before}, ${max})`);
  return out ? out.split("\n") : [];
}

test("the tick's !new requests: open, untold, keyed new:; never a mention's, a cancelled one or a told one", { skip }, () => {
  const m = mission();
  const t = thread(m, "1731400500.000100");
  const at = (minutes: number) => `now() - interval '${minutes} minutes'`;
  psql(`insert into mission_slack_requests (mission_id, request_key, source, thread_id, created_at) values ('${m}', 'new:EvA', 'slack', '${t}', ${at(5)})`);
  // Its root post's thread not set yet (a crash): still the tick's, which decides by the root post.
  psql(`insert into mission_slack_requests (mission_id, request_key, source, created_at) values ('${m}', 'new:EvB', 'slack', ${at(4)})`);
  // A mention's: told inline, never marked told.
  psql(`insert into mission_slack_requests (mission_id, request_key, source, thread_id, created_at) values ('${m}', 'EvMention', 'slack', '${t}', ${at(6)})`);
  psql(`insert into mission_slack_requests (mission_id, request_key, source, thread_id, status, created_at) values ('${m}', 'new:EvCancelled', 'slack', '${t}', 'cancelled', ${at(6)})`);
  psql(`insert into mission_slack_requests (mission_id, request_key, source, thread_id, announced_at, created_at) values ('${m}', 'new:EvTold', 'slack', '${t}', now(), ${at(6)})`);
  // A trigger's: the other query's, never this one's.
  psql(`insert into mission_slack_requests (mission_id, request_key, source, created_at) values ('${m}', 'new:webhook', 'webhook', ${at(6)})`);
  // Only keys that start `new:`.
  psql(`insert into mission_slack_requests (mission_id, request_key, source, created_at) values ('${m}', 'newX:Ev', 'slack', ${at(6)})`);
  assert.deepEqual(untold(), ["new:EvA", "new:EvB"]);
  // Made before the cutoff only, and at most `max_rows`.
  assert.deepEqual(untold(at(3)), ["new:EvA", "new:EvB"]);
  assert.deepEqual(untold(at(5) + " + interval '1 second'"), ["new:EvA"]);
  assert.deepEqual(untold(undefined, 1), ["new:EvA"]);
  // Told: no longer the tick's.
  psql(`update mission_slack_requests set announced_at = now() where request_key = 'new:EvA'`);
  assert.deepEqual(untold(), ["new:EvB"]);
});

test("only the service role may call it", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(psql(`select has_function_privilege('${role}', 'unannounced_new_requests(timestamptz, integer)', 'execute')`), "f", role);
  }
  assert.equal(psql(`select has_function_privilege('service_role', 'unannounced_new_requests(timestamptz, integer)', 'execute')`), "t");
});

test("the assignee columns: set on a request, cleared when the person goes", { skip }, () => {
  const m = mission();
  const pat = psql(`insert into auth.users default values returning id`);
  psql(`insert into mission_slack_requests (mission_id, request_key, assignee_user_id, assigned_by, assigned_at) values ('${m}', 'Ev1', '${pat}', '${pat}', now())`);
  assert.equal(psql(`select assignee_user_id = '${pat}' and assigned_at is not null from mission_slack_requests where request_key = 'Ev1'`), "t");
  psql(`delete from auth.users where id = '${pat}'`);
  assert.equal(psql(`select coalesce(assignee_user_id::text, 'null') || ',' || coalesce(assigned_by::text, 'null') from mission_slack_requests where request_key = 'Ev1'`), "null,null");
});
