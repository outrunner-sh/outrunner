/**
 * The on-call Missions migration's SQL (20261112200000_mission_slack.sql), run
 * on a real Postgres after the Missions migrations before it: Slack's events
 * with no Ship, one Mission a channel and one channel a Mission, threads, and
 * the limits on Ships under racing spawns. Needs MISSIONS_PG, as
 * test/missions-sql.test.ts does; skipped without one.
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
const name = `mission_slack_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

async function psqlAsync(sql: string): Promise<string> {
  return (await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" })).stdout.trim();
}

function fails(sql: string, pattern: RegExp) {
  assert.throws(
    () => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }),
    (error: { stderr?: string }) => pattern.test(String(error.stderr)),
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

function org(): string {
  return psql("insert into organizations default values returning id");
}

function mission(): string {
  return psql(`insert into workspaces (owner_id, kind, status) values ('${OWNER}', 'mission', 'ready') returning id`);
}

function runner(missionId: string): string {
  return psql(`insert into workspaces (owner_id, parent_mission_id, status) values ('${OWNER}', '${missionId}', 'creating') returning id`);
}

function bind(missionId: string, orgId: string, channel: string, team = "T1"): void {
  psql(`insert into mission_channels (mission_id, org_id, slack_team_id, channel_id) values ('${missionId}', '${orgId}', '${team}', '${channel}')`);
}

test("Slack's events need no Ship; the Ships' own kinds still do", { skip }, () => {
  const m = mission();
  psql(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'slack_request', 'slack_request:Ev1')`);
  psql(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'slack_answer', 'slack_answer:a1')`);
  psql(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'slack_channel', 'slack_channel:x')`);
  fails(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'finished', 'f:none')`, /mission_events_runner_check/);
  fails(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'bogus', 'b:none')`, /mission_events_kind_check/);
  // A retried Slack event is the same key: recorded once.
  psql(
    `insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'slack_request', 'slack_request:Ev1') on conflict (idempotency_key) do nothing`,
  );
  assert.equal(psql(`select count(*) from mission_events where mission_id = '${m}' and kind = 'slack_request'`), "1");
});

test("Slack's events are delivered with a Ship's, through the same claims", { skip }, () => {
  const m = mission();
  const r = runner(m);
  psql(`insert into mission_events (mission_id, runner_id, kind, idempotency_key, created_at) values ('${m}', '${r}', 'finished', 'f:${m}', now() - interval '1 minute')`);
  psql(`insert into mission_events (mission_id, kind, idempotency_key, created_at) values ('${m}', 'slack_request', 'slack_request:${m}', now() - interval '1 minute')`);
  const claimed = psql(`select delivery_id from claim_mission_delivery('${m}', 600, 3, 30)`);
  assert.ok(claimed);
  assert.equal(psql(`select count(*) from mission_events where delivery_id = '${claimed}'`), "2");
  psql(`select complete_mission_delivery('${claimed}')`);
  assert.equal(psql(`select count(*) from mission_events where mission_id = '${m}' and delivered_at is null`), "0");
});

test("one Mission a channel, and one channel a Mission", { skip }, () => {
  const o = org();
  const a = mission();
  const b = mission();
  bind(a, o, "C100");
  fails(`insert into mission_channels (mission_id, org_id, slack_team_id, channel_id) values ('${b}', '${o}', 'T1', 'C100')`, /mission_channels_channel_unique/);
  fails(`insert into mission_channels (mission_id, org_id, slack_team_id, channel_id) values ('${a}', '${o}', 'T1', 'C200')`, /mission_channels_pkey/);
  // The same channel id in another Slack workspace is another channel.
  bind(b, o, "C100", "T2");
  assert.equal(psql(`select listen || ',' || allow_bot_messages || ',' || paused from mission_channels where mission_id = '${a}'`), "mentions,false,false");
  fails(`update mission_channels set listen = 'everything' where mission_id = '${a}'`, /listen_check/);
  fails(`insert into mission_channels (mission_id, org_id, slack_team_id, channel_id) values ('${mission()}', '${o}', 'T1', 'D123')`, /channel_id_check/);
  // A Mission deleted lets its channel go.
  psql(`delete from workspaces where id = '${a}'`);
  assert.equal(psql(`select count(*) from mission_channels where slack_team_id = 'T1' and channel_id = 'C100'`), "0");
});

test("a thread is one Mission's, and handed over on conflict", { skip }, () => {
  const a = mission();
  const b = mission();
  psql(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${a}', 'T1', 'C300', '1731400000.000100')`);
  fails(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${b}', 'T1', 'C300', '1731400000.000100')`, /mission_threads_thread_unique/);
  psql(
    `insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${b}', 'T1', 'C300', '1731400000.000100') on conflict (slack_team_id, channel_id, thread_ts) do update set mission_id = excluded.mission_id`,
  );
  assert.equal(psql(`select mission_id from mission_threads where thread_ts = '1731400000.000100'`), b);
  fails(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${a}', 'T1', 'C300', 'not-a-ts')`, /thread_ts_check/);
});

function reserve(m: string): string {
  return psql(`select coalesce(ship_id::text, refusal) from reserve_mission_slack_ship('${m}', null, null, 'U1')`);
}

function limitApplied(m: string): string {
  return psql(`select refused_at_limit from reserve_mission_slack_ship('${m}', null, null, 'U1')`);
}

test("6 Ships an hour, then 30 a day; a failed start gives its place back", { skip }, () => {
  const m = mission();
  const taken = Array.from({ length: 6 }, () => reserve(m));
  assert.ok(taken.every((t) => /^[0-9a-f-]{36}$/.test(t)));
  assert.equal(reserve(m), "hour");
  psql(`select release_mission_slack_ship('${taken[0]}')`);
  assert.match(reserve(m), /^[0-9a-f-]{36}$/);
  // One with its Ship isn't given back.
  const r = runner(m);
  psql(`update mission_slack_ships set runner_id = '${r}' where id = '${taken[1]}'`);
  psql(`select release_mission_slack_ship('${taken[1]}')`);
  assert.equal(psql(`select count(*) from mission_slack_ships where mission_id = '${m}'`), "6");
  // Older than an hour: four more hours' worth, aged as they'd be, fill the
  // day's 30.
  for (let hour = 0; hour < 4; hour++) {
    psql(`update mission_slack_ships set created_at = now() - interval '2 hours' where mission_id = '${m}'`);
    for (let i = 0; i < 6; i++) assert.match(reserve(m), /^[0-9a-f-]{36}$/, `hour ${hour}, reservation ${i}`);
    assert.equal(reserve(m), "hour");
  }
  psql(`update mission_slack_ships set created_at = now() - interval '2 hours' where mission_id = '${m}'`);
  assert.equal(psql(`select count(*) from mission_slack_ships where mission_id = '${m}'`), "30");
  assert.equal(reserve(m), "day");
  // A Mission's own limits.
  const n = mission();
  psql(`insert into mission_limits (mission_id, slack_ships_per_hour, slack_ships_per_day) values ('${n}', 1, 1)`);
  assert.match(reserve(n), /^[0-9a-f-]{36}$/);
  assert.equal(reserve(n), "hour");
  // The refusal names the limit it applied: the Mission's own.
  assert.equal(limitApplied(n), "1");
});

test("spawns racing for the hour's last place: one wins", { skip }, async () => {
  const m = mission();
  for (let i = 0; i < 5; i++) reserve(m);
  const sql = `select coalesce(ship_id::text, refusal) from reserve_mission_slack_ship('${m}', null, null, 'U1')`;
  const results = await Promise.all([psqlAsync(sql), psqlAsync(sql), psqlAsync(sql), psqlAsync(sql)]);
  assert.equal(results.filter((r) => r !== "hour").length, 1);
  assert.equal(psql(`select count(*) from mission_slack_ships where mission_id = '${m}'`), "6");
});

test("a question is answered once", { skip }, () => {
  const m = mission();
  const t = psql(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${m}', 'T1', 'C400', '1731400000.000200') returning id`);
  const ask = psql(`insert into mission_slack_asks (mission_id, thread_id, question, options) values ('${m}', '${t}', 'Which?', '{a,b}') returning id`);
  const claim = () => psql(`update mission_slack_asks set answer = 'a', answered_at = now() where id = '${ask}' and answered_at is null returning id`);
  assert.equal(claim(), ask);
  assert.equal(claim(), "");
  fails(`insert into mission_slack_asks (mission_id, thread_id, question, options) values ('${m}', '${t}', 'Which?', '{}')`, /options_check/);
});

// ---------------------------------------------------------------------------
// 20261112210000_mission_slack_reliability.sql
// ---------------------------------------------------------------------------

test("a binding made again is a new revision", { skip }, () => {
  const o = org();
  const m = mission();
  bind(m, o, "C500");
  const first = psql(`select revision from mission_channels where mission_id = '${m}'`);
  psql(`delete from mission_channels where mission_id = '${m}'`);
  bind(m, o, "C500");
  assert.notEqual(psql(`select revision from mission_channels where mission_id = '${m}'`), first);
});

function inbound(id: string): void {
  psql(`insert into mission_slack_inbound (event_id, team_id, channel_id, message) values ('${id}', 'T1', 'C1', '{"text":"hi"}') on conflict (event_id) do nothing`);
}

function claimInbound(id: string): string {
  return psql(`select attempt from claim_mission_slack_inbound('${id}', 120)`);
}

test("a saved event is one row however often Slack sends it, and taken under a lease", { skip }, () => {
  inbound("EvA");
  inbound("EvA");
  assert.equal(psql(`select count(*) from mission_slack_inbound where event_id = 'EvA'`), "1");
  assert.equal(claimInbound("EvA"), "1");
  assert.equal(claimInbound("EvA"), "", "held by the first");
  // Not due to the tick while leased.
  assert.equal(psql(`select count(*) from due_mission_slack_inbound(100, 0) where event_id = 'EvA'`), "0");
});

test("a processor that dies: its lease runs out, the tick takes it over, and the dead one can't finish it", { skip }, () => {
  inbound("EvB");
  assert.equal(claimInbound("EvB"), "1");
  psql(`update mission_slack_inbound set lease_until = now() - interval '1 second' where event_id = 'EvB'`);
  assert.equal(psql(`select count(*) from due_mission_slack_inbound(100, 0) where event_id = 'EvB'`), "1");
  assert.equal(claimInbound("EvB"), "2");
  assert.equal(psql(`select complete_mission_slack_inbound('EvB', 1)`), "f", "the first claim's finish is stale");
  assert.equal(psql(`select complete_mission_slack_inbound('EvB', 2)`), "t");
  assert.equal(psql(`select status from mission_slack_inbound where event_id = 'EvB'`), "done");
  assert.equal(claimInbound("EvB"), "", "done is done");
});

test("a failure backs off, and is given up after its tries; the tick's grace lets the first processor go first", { skip }, () => {
  inbound("EvC");
  assert.equal(psql(`select count(*) from due_mission_slack_inbound(100, 60) where event_id = 'EvC'`), "0", "too new for the tick");
  claimInbound("EvC");
  psql(`select fail_mission_slack_inbound('EvC', 1, 'blip', 2)`);
  assert.equal(psql(`select status || ',' || (next_attempt_at > now()) || ',' || (lease_until is null) from mission_slack_inbound where event_id = 'EvC'`), "pending,true,true");
  assert.equal(claimInbound("EvC"), "", "backing off");
  psql(`update mission_slack_inbound set next_attempt_at = now() where event_id = 'EvC'`);
  assert.equal(claimInbound("EvC"), "2");
  psql(`select fail_mission_slack_inbound('EvC', 2, 'blip', 2)`);
  assert.equal(psql(`select status from mission_slack_inbound where event_id = 'EvC'`), "failed");
});

function spawnKey(m: string, request: string | null, key: string): string[] {
  return psql(
    `select coalesce(ship_id::text, '-') || ',' || coalesce(planned_runner_id::text, '-') || ',' || coalesce(runner_id::text, '-') || ',' || existing || ',' || coalesce(refusal, '-') from reserve_mission_slack_spawn('${m}', ${request ? `'${request}'` : "null"}, '${key}', null, null, 'U1', null)`,
  ).split(",");
}

test("a Ship start's key: reserved once, the same planned session id on a retry, its Ship once linked", { skip }, () => {
  const m = mission();
  const [ship, planned, runnerId, existing] = spawnKey(m, "Ev1", "fix-login");
  assert.equal(runnerId, "-");
  assert.equal(existing, "false");
  const again = spawnKey(m, "Ev1", "fix-login");
  assert.deepEqual(again.slice(0, 4), [ship, planned, "-", "true"]);
  // Another key, or the same key for another request: another start.
  assert.notEqual(spawnKey(m, "Ev1", "fix-tests")[1], planned);
  assert.notEqual(spawnKey(m, "Ev2", "fix-login")[1], planned);
  // No request: keyed all the same.
  assert.equal(spawnKey(m, null, "chore")[3], "false");
  assert.equal(spawnKey(m, null, "chore")[3], "true");
  // Its Ship made: the retry returns it.
  const r = runner(m);
  psql(`update mission_slack_ships set runner_id = '${r}' where id = '${ship}'`);
  assert.equal(spawnKey(m, "Ev1", "fix-login")[2], r);
  fails(`select * from reserve_mission_slack_spawn('${m}', 'Ev1', 'has space', null, null, null, null)`, /spawn_key_check/);
});

test("spawn keys and the limits count together; a key already reserved still answers at the limit", { skip }, () => {
  const m = mission();
  for (let i = 0; i < 3; i++) reserve(m);
  for (let i = 0; i < 3; i++) assert.equal(spawnKey(m, "Ev1", `k${i}`)[3], "false");
  assert.equal(spawnKey(m, "Ev1", "k9")[4], "hour");
  assert.equal(reserve(m), "hour");
  assert.equal(spawnKey(m, "Ev1", "k0")[3], "true");
});

test("the same key racing itself: one reservation, one planned session", { skip }, async () => {
  const m = mission();
  const sql = `select planned_runner_id from reserve_mission_slack_spawn('${m}', 'Ev1', 'race', null, null, null, null)`;
  const results = await Promise.all([psqlAsync(sql), psqlAsync(sql), psqlAsync(sql), psqlAsync(sql)]);
  assert.equal(new Set(results).size, 1);
  assert.equal(psql(`select count(*) from mission_slack_ships where mission_id = '${m}'`), "1");
});

function post(m: string, key: string, channel: string, thread: string, age: string): string {
  return psql(
    `insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload, created_at) values ('${key}', '${m}', gen_random_uuid(), 'T1', '${channel}', '${thread}', 'reply', '{"chunks":["x"]}', now() - interval '${age}') on conflict (op_key) do nothing returning id`,
  );
}

function claimPosts(target: string | null = null): string[] {
  const out = psql(`select op_key from claim_mission_slack_posts(${target ? `'${target}'` : "null"}, 10, 120) order by op_key`);
  return out ? out.split("\n") : [];
}

test("posts: once a key; a thread's oldest goes first; a claimed one is held by its lease", { skip }, () => {
  const m = mission();
  const first = post(m, `a1:${m}`, "C100", "1731400000.000100", "3 minutes");
  assert.equal(post(m, `a1:${m}`, "C100", "1731400000.000100", "1 minute"), "", "queued once");
  post(m, `a2:${m}`, "C100", "1731400000.000100", "2 minutes");
  post(m, `b1:${m}`, "C100", "1731400000.000900", "1 minute");
  // The second of thread a waits behind the first.
  assert.deepEqual(claimPosts(), [`a1:${m}`, `b1:${m}`]);
  assert.deepEqual(claimPosts(), [], "all held, or waiting their turn");
  psql(`update mission_slack_posts set status = 'sent', lease_until = null where id = '${first}'`);
  assert.deepEqual(claimPosts(), [`a2:${m}`]);
  // A lease run out: taken again, as attempt 2.
  psql(`update mission_slack_posts set lease_until = now() - interval '1 second' where op_key = 'b1:${m}'`);
  assert.deepEqual(claimPosts(), [`b1:${m}`]);
  assert.equal(psql(`select attempts from mission_slack_posts where op_key = 'b1:${m}'`), "2");
  // A post can't be retargeted: its channel is its own.
  fails(`update mission_slack_posts set channel_id = 'D1' where op_key = 'b1:${m}'`, /channel_id_check/);
});

test("an ambiguous or failed post doesn't hold its thread up; a question card is asked once", { skip }, () => {
  const m = mission();
  const stuck = post(m, `s1:${m}`, "C200", "1731400000.000100", "2 minutes");
  post(m, `s2:${m}`, "C200", "1731400000.000100", "1 minute");
  psql(`update mission_slack_posts set status = 'ambiguous' where id = '${stuck}'`);
  assert.deepEqual(claimPosts(), [`s2:${m}`]);
  const t = psql(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${m}', 'T1', 'C200', '1731400000.000100') returning id`);
  psql(`insert into mission_slack_asks (mission_id, thread_id, question, options, op_key) values ('${m}', '${t}', 'q', '{a}', 'ask:${m}')`);
  fails(`insert into mission_slack_asks (mission_id, thread_id, question, options, op_key) values ('${m}', '${t}', 'q', '{a}', 'ask:${m}')`, /op_key_key/);
});

// ---------------------------------------------------------------------------
// 20261113100000_mission_inputs.sql
// ---------------------------------------------------------------------------

function missionAutomation(m: string, triggers: string, inputs = "{}"): string {
  return psql(
    `select create_mission_automation(gen_random_uuid(), null, 'a', null, 'p', '${triggers}', true, '{}', '{}', jsonb_build_object('mission_id', '${m}') || '${inputs}'::jsonb)`,
  );
}

test("existing automations are sessions' and stay so; a Mission's needs its Mission", { skip }, () => {
  assert.equal(psql(`select string_agg(distinct target_kind, ',') from automations where target_mission_id is null`), "session");
  fails(`insert into automations (triggers, target_kind) values ('{schedule}', 'mission')`, /automations_target_check/);
  fails(`insert into automations (triggers, target_kind, target_mission_id) values ('{schedule}', 'session', '${mission()}')`, /automations_target_check/);
  // A watched channel or Linear are a Mission's only.
  fails(`insert into automations (triggers) values ('{slack.message}')`, /automations_inputs_check/);
  fails(`insert into automations (triggers) values ('{linear.issue}')`, /automations_inputs_check/);
});

test("a Mission's automation is made whole, with its inputs; its triggers are a Mission's", { skip }, () => {
  const m = mission();
  const watching = missionAutomation(m, "{slack.message}", `{"watch_team_id":"T1","watch_channel_id":"C500","filter_prompt":"bugs","allowed_app_ids":["A123"]}`);
  assert.equal(psql(`select target_kind || ',' || watch_channel_id || ',' || array_to_string(allowed_app_ids, ',') from automations where id = '${watching}'`), "mission,C500,A123");
  // A watch with no channel, Linear with no team, a GitHub trigger: refused.
  fails(`select create_mission_automation(gen_random_uuid(), null, 'a', null, 'p', '{slack.message}', true, '{}', '{}', '{"mission_id":"${m}"}')`, /automations_inputs_check/);
  fails(`select create_mission_automation(gen_random_uuid(), null, 'a', null, 'p', '{linear.issue}', true, '{}', '{}', '{"mission_id":"${m}"}')`, /automations_inputs_check/);
  fails(`select create_mission_automation(gen_random_uuid(), null, 'a', null, 'p', '{pull_request.opened}', true, '{}', '{}', '{"mission_id":"${m}"}')`, /automations_inputs_check/);
  const linear = missionAutomation(m, "{linear.issue,webhook}", `{"linear_team_ids":["team-1"]}`);
  // Inputs change; its target doesn't.
  const org = psql(`select org_id from automations where id = '${linear}'`);
  assert.equal(psql(`select set_mission_automation_inputs('${org}', '${linear}', '{"linear_team_ids":["team-2"],"webhook_hmac_sealed":"sealed"}')`), "t");
  // Another org's call changes nothing.
  assert.equal(psql(`select set_mission_automation_inputs(gen_random_uuid(), '${linear}', '{"linear_team_ids":[]}')`), "f");
  assert.equal(psql(`select array_to_string(linear_team_ids, ',') || ',' || webhook_hmac_sealed from automations where id = '${linear}'`), "team-2,sealed");
  // A Mission deleted takes its automations with it.
  psql(`delete from workspaces where id = '${m}'`);
  assert.equal(psql(`select count(*) from automations where id in ('${watching}', '${linear}')`), "0");
});

test("runs: a Mission's triggers, and skipped with why", { skip }, () => {
  const a = psql(`select id from automations limit 1`);
  psql(`insert into automation_runs (automation_id, trigger, status) values ('${a}', 'slack.message', 'skipped'), ('${a}', 'linear.issue', 'ready')`);
  fails(`insert into automation_runs (automation_id, trigger, status) values ('${a}', 'schedule', 'maybe')`, /automation_runs_status_check/);
});

test("one Slack message is one request anywhere: the first claim has it", { skip }, () => {
  const a = mission();
  const b = mission();
  psql(`insert into mission_slack_message_claims (slack_team_id, channel_id, message_ts, mission_id, source, claim_key) values ('T1', 'C600', '1731400000.000100', '${a}', 'slack', 'slack:Ev1')`);
  fails(
    `insert into mission_slack_message_claims (slack_team_id, channel_id, message_ts, mission_id, source, claim_key) values ('T1', 'C600', '1731400000.000100', '${b}', 'slack_watch', 'run:x')`,
    /mission_slack_message_claims_pkey/,
  );
});

test("requests carry their source, details and status; trigger requests go untold until told", { skip }, () => {
  const m = mission();
  psql(`insert into mission_slack_requests (mission_id, request_key, source, title, details) values ('${m}', 'run:1', 'webhook', 'Deploy', '{"text":"go"}')`);
  assert.equal(psql(`select source || ',' || status || ',' || (announced_at is null) from mission_slack_requests where request_key = 'run:1'`), "webhook,open,true");
  fails(`insert into mission_slack_requests (mission_id, request_key, source) values ('${m}', 'run:2', 'email')`, /source_check/);
  fails(`update mission_slack_requests set status = 'done' where request_key = 'run:1'`, /status_check/);
  // Slack's own, from before, are Slack's.
  psql(`insert into mission_slack_requests (mission_id, request_key) values ('${m}', 'Ev9')`);
  assert.equal(psql(`select source from mission_slack_requests where request_key = 'Ev9'`), "slack");
  psql(`insert into mission_events (mission_id, kind, idempotency_key) values ('${m}', 'request', 'request:${m}:run:1'), ('${m}', 'request_cancelled', 'request_cancelled:${m}:run:1')`);
});

test("a root post has no thread yet, and only a root post", { skip }, () => {
  const m = mission();
  psql(
    `insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload, request_key) values ('root:${m}', '${m}', gen_random_uuid(), 'T1', 'C700', null, 'root', '{"chunks":["x"]}', 'run:1')`,
  );
  fails(
    `insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload) values ('reply:${m}', '${m}', gen_random_uuid(), 'T1', 'C700', null, 'reply', '{"chunks":["x"]}')`,
    /root_check/,
  );
  // Roots don't hold each other up: each is its own thread to be.
  psql(
    `insert into mission_slack_posts (op_key, mission_id, binding_revision, team_id, channel_id, thread_ts, kind, payload, request_key) values ('root2:${m}', '${m}', gen_random_uuid(), 'T1', 'C700', null, 'root', '{"chunks":["y"]}', 'run:2')`,
  );
  assert.deepEqual(claimPosts().filter((k) => k.endsWith(m)).sort(), [`root2:${m}`, `root:${m}`].sort());
});

test("a delegation is approved only with an approver", { skip }, () => {
  const m = mission();
  const a = missionAutomation(m, "{schedule}");
  psql(`insert into mission_delegations (automation_id, mission_id) values ('${a}', '${m}')`);
  fails(`update mission_delegations set approved_at = now() where automation_id = '${a}'`, /mission_delegations_check/);
  psql(`insert into auth.users (id) values ('${OWNER}') on conflict do nothing`);
  psql(`update mission_delegations set approved_at = now(), approved_by = '${OWNER}' where automation_id = '${a}'`);
});
