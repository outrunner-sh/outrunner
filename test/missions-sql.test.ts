/**
 * The Missions migrations' SQL, run on a real Postgres: the cap on a Mission's
 * Runners and the outbox's claims. Needs a server to make a database on, named
 * by MISSIONS_PG (psql's connection URL, e.g.
 * postgresql://postgres@localhost:55432/postgres); skipped without one.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";
const run = promisify(execFile);

let url = "";
const name = `missions_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

async function psqlAsync(sql: string): Promise<string> {
  return (await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" })).stdout.trim();
}

function fails(sql: string, pattern: RegExp) {
  assert.throws(() => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }), (error: { stderr?: string }) =>
    pattern.test(String(error.stderr)),
  );
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
const OTHER = "00000000-0000-0000-0000-00000000000b";

function mission(owner = OWNER): string {
  return psql(`insert into workspaces (owner_id, kind, status) values ('${owner}', 'mission', 'ready') returning id`);
}

function runner(missionId: string, status = "creating", owner = OWNER): string {
  return psql(`insert into workspaces (owner_id, parent_mission_id, status) values ('${owner}', '${missionId}', '${status}') returning id`);
}

test("a Mission holds 20 live Runners; archived and failed ones don't count", { skip }, () => {
  const m = mission();
  for (let i = 0; i < 18; i++) runner(m);
  const archived = runner(m, "ready");
  psql(`update workspaces set status = 'archived' where id = '${archived}'`);
  runner(m, "failed");
  runner(m);
  runner(m);
  fails(`insert into workspaces (owner_id, parent_mission_id) values ('${OWNER}', '${m}')`, /mission_runner_cap/);
  // Coming back from archived takes a place too: none left.
  fails(`update workspaces set status = 'restoring' where id = '${archived}'`, /mission_runner_cap/);
});

test("two spawns racing for the last place: one wins", { skip }, async () => {
  const m = mission();
  for (let i = 0; i < 19; i++) runner(m);
  const insert = `insert into workspaces (owner_id, parent_mission_id) values ('${OWNER}', '${m}') returning id`;
  const results = await Promise.allSettled([psqlAsync(insert), psqlAsync(insert), psqlAsync(insert)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(psql(`select count(*) from workspaces where parent_mission_id = '${m}'`), "20");
});

test("a Runner's parent is a Mission of its owner's, and a Mission is no Runner", { skip }, () => {
  const m = mission();
  const plain = psql(`insert into workspaces (owner_id, status) values ('${OWNER}', 'ready') returning id`);
  fails(`insert into workspaces (owner_id, parent_mission_id) values ('${OWNER}', '${plain}')`, /parent must be a Mission/);
  fails(`insert into workspaces (owner_id, parent_mission_id) values ('${OTHER}', '${m}')`, /Mission's owner/);
  fails(`insert into workspaces (owner_id, kind, parent_mission_id) values ('${OWNER}', 'mission', '${m}')`, /can't be a Runner/);
  const r = runner(m);
  // A Runner's Runners: its parent would have to be a Mission.
  fails(`insert into workspaces (owner_id, parent_mission_id) values ('${OWNER}', '${r}')`, /parent must be a Mission/);
});

function event(m: string, r: string, key: string, age = "1 minute"): void {
  psql(
    `insert into mission_events (mission_id, runner_id, kind, idempotency_key, created_at) values ('${m}', '${r}', 'finished', '${key}', now() - interval '${age}') on conflict (idempotency_key) do nothing`,
  );
}

function claim(m: string, settle = 3, maxWait = 30): { id: string; attempt: number } | null {
  const row = psql(`select delivery_id || ',' || attempt from claim_mission_delivery('${m}', 600, ${settle}, ${maxWait})`);
  if (!row) return null;
  const [id, attempt] = row.split(",");
  return { id, attempt: Number(attempt) };
}

test("an event is recorded once, however often it's seen", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, "finished:x");
  event(m, r, "finished:x");
  assert.equal(psql(`select count(*) from mission_events where mission_id = '${m}'`), "1");
});

test("events that arrive together go as one delivery, once they've settled", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, `a:${m}`, "10 seconds");
  event(m, r, `b:${m}`, "1 second");
  // The newest is a second old: wait for more.
  assert.equal(claim(m), null);
  psql(`update mission_events set created_at = created_at - interval '5 seconds' where mission_id = '${m}'`);
  const d = claim(m);
  assert.ok(d);
  assert.equal(psql(`select count(*) from mission_events where delivery_id = '${d.id}'`), "2");
  // Held: no one else takes it.
  assert.equal(claim(m), null);
  psql(`select complete_mission_delivery('${d.id}')`);
  assert.equal(psql(`select count(*) from mission_events where mission_id = '${m}' and delivered_at is null`), "0");
  assert.equal(claim(m), null);
});

test("a stream of events still goes after the longest wait", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, `old:${m}`, "40 seconds");
  event(m, r, `new:${m}`, "0 seconds");
  assert.ok(claim(m));
});

test("racing claimers: exactly one takes the delivery", { skip }, async () => {
  const m = mission();
  const r = runner(m);
  for (let i = 0; i < 5; i++) event(m, r, `race${i}:${m}`);
  const sql = `select delivery_id from claim_mission_delivery('${m}', 600, 3, 30)`;
  const claims = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(sql)));
  assert.equal(claims.filter((c) => c !== "").length, 1);
});

test("a claimer that dies is taken over with the same delivery and events; later events wait", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, `one:${m}`);
  const first = claim(m);
  assert.ok(first);
  // A new event while it was out: not in the delivery already tried.
  event(m, r, `two:${m}`);
  // The lease runs out (the control plane restarted mid-send).
  psql(`update mission_deliveries set lease_until = now() - interval '1 second' where id = '${first.id}'`);
  const again = claim(m);
  assert.deepEqual(again, { id: first.id, attempt: 2 });
  assert.equal(psql(`select string_agg(idempotency_key, ',') from mission_events where delivery_id = '${first.id}'`), `one:${m}`);
  psql(`select complete_mission_delivery('${first.id}')`);
  const next = claim(m);
  assert.ok(next && next.id !== first.id);
  assert.equal(psql(`select string_agg(idempotency_key, ',') from mission_events where delivery_id = '${next.id}'`), `two:${m}`);
});

test("a failed send backs off, doubling, then is tried again; nothing is dropped", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, `f:${m}`);
  const d = claim(m);
  assert.ok(d);
  psql(`select fail_mission_delivery('${d.id}', 'the Mission is asleep')`);
  assert.equal(claim(m), null);
  const wait = (n: number) => Number(psql(`select round(extract(epoch from next_attempt_at - now())) from mission_deliveries where id = '${d.id}'`)) + n;
  assert.ok(wait(0) > 10 && wait(0) <= 15);
  psql(`update mission_deliveries set next_attempt_at = now() where id = '${d.id}'`);
  assert.deepEqual(claim(m), { id: d.id, attempt: 2 });
  psql(`select fail_mission_delivery('${d.id}', 'again')`);
  assert.ok(wait(0) > 25 && wait(0) <= 30);
  assert.equal(psql(`select last_error from mission_deliveries where id = '${d.id}'`), "again");
});

test("a delivery tried for hours still backs off, capped at ten minutes", { skip }, () => {
  const m = mission();
  const r = runner(m);
  event(m, r, `long:${m}`);
  const d = claim(m);
  assert.ok(d);
  psql(`update mission_deliveries set attempts = 40 where id = '${d.id}'`);
  // Past where 15 × 2^(n−1) would overflow an integer: no error, ten minutes.
  psql(`select fail_mission_delivery('${d.id}', 'still asleep')`);
  const wait = Number(psql(`select round(extract(epoch from next_attempt_at - now())) from mission_deliveries where id = '${d.id}'`));
  assert.ok(wait > 590 && wait <= 600, String(wait));
});

test("the tick is told Missions whose events are due, oldest first, not those backing off or held", { skip }, () => {
  const waitingLong = mission();
  const backingOff = mission();
  const held = mission();
  for (const [m, age] of [
    [waitingLong, "5 minutes"],
    [backingOff, "10 minutes"],
    [held, "20 minutes"],
  ] as const) {
    event(m, runner(m), `due:${m}`, age);
  }
  const off = claim(backingOff);
  psql(`select fail_mission_delivery('${off!.id}', 'asleep')`);
  claim(held);
  // News that comes while their deliveries wait isn't due either.
  event(backingOff, runner(backingOff), `later:${backingOff}`, "1 minute");
  event(held, runner(held), `later:${held}`, "1 minute");
  const due = psql(`select string_agg(mission_id::text, ',') from missions_with_pending_events(1000)`).split(",");
  assert.ok(due.includes(waitingLong));
  assert.ok(!due.includes(backingOff));
  assert.ok(!due.includes(held));
});
