/**
 * The idle pause's SQL (20261114210100_mission_idle_pause.sql) on a real
 * Postgres, after the Missions migrations before it: the offer at 2 weeks
 * and not before, once under racing sweeps, its post queued with it; a
 * human's reply calling it off; the pause 24 hours on, with its words; a
 * binding a person paused left alone; a rebind starting fresh. Needs
 * MISSIONS_PG, as test/mission-slack-sql.test.ts does; skipped without one.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { IDLE_OFFER_TEXT, IDLE_PAUSE_TEXT } from "@/lib/missions/slack-text";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";
const run = promisify(execFile);

let url = "";
const name = `mission_idle_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const IDLE = 14 * 24 * 60 * 60;
const GRACE = 24 * 60 * 60;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

async function psqlAsync(sql: string): Promise<string> {
  return (await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" })).stdout.trim();
}

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const offerSql = `select mission_id from offer_mission_idle_pauses(${IDLE}, ${quote(IDLE_OFFER_TEXT)}, 50)`;
const pauseSql = `select mission_id from pause_idle_missions(${GRACE}, ${quote(IDLE_PAUSE_TEXT)}, 50)`;
const lines = (out: string) => out.split("\n").filter(Boolean);

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
let channels = 0;

/** A Mission bound to a fresh channel, its last human `ago` back. */
function bound(ago: string, patch = ""): { mission: string; channel: string } {
  const org = psql("insert into organizations default values returning id");
  const mission = psql(`insert into workspaces (owner_id, kind, status) values ('${OWNER}', 'mission', 'ready') returning id`);
  const channel = `CIDLE${++channels}`;
  psql(
    `insert into mission_channels (mission_id, org_id, slack_team_id, channel_id, last_human_at) values ('${mission}', '${org}', 'T1', '${channel}', now() - interval '${ago}')`,
  );
  if (patch) psql(`update mission_channels set ${patch} where mission_id = '${mission}'`);
  return { mission, channel };
}

function state(mission: string): { paused: boolean; idlePaused: boolean; warned: boolean } {
  const [paused, idlePaused, warned] = psql(`select paused, idle_paused, idle_warned_at is not null from mission_channels where mission_id = '${mission}'`).split("|");
  return { paused: paused === "t", idlePaused: idlePaused === "t", warned: warned === "t" };
}

function posts(mission: string): { kind: string; thread: string; text: string; key: string }[] {
  return lines(psql(`select kind, coalesce(thread_ts, '-'), payload->'chunks'->>0, op_key from mission_slack_posts where mission_id = '${mission}' order by created_at, op_key`)).map((l) => {
    const [kind, thread, text, key] = l.split("|");
    return { kind, thread, text, key };
  });
}

/** Only this test's binding: the sweeps take every one due. */
function only(out: string, mission: string): string[] {
  return lines(out).filter((m) => m === mission);
}

test("no offer before 2 weeks; at 2 weeks one, its root post queued with it", { skip }, () => {
  const { mission } = bound("13 days 23 hours");
  assert.deepEqual(only(psql(offerSql), mission), []);
  assert.equal(state(mission).warned, false);
  assert.deepEqual(posts(mission), []);

  psql(`update mission_channels set last_human_at = now() - interval '14 days' where mission_id = '${mission}'`);
  assert.deepEqual(only(psql(offerSql), mission), [mission]);
  assert.equal(state(mission).warned, true);
  const queued = posts(mission);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "root");
  assert.equal(queued[0].thread, "-");
  assert.equal(queued[0].text, IDLE_OFFER_TEXT);
  assert.match(queued[0].key, /^idle_offer:/);
  // Run again (a retried tick): nothing more.
  assert.deepEqual(only(psql(offerSql), mission), []);
  assert.equal(posts(mission).length, 1);
});

test("racing sweeps offer once and queue one post", { skip }, async () => {
  const { mission } = bound("15 days");
  const outs = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(offerSql)));
  assert.equal(outs.flatMap((o) => only(o, mission)).length, 1);
  assert.equal(posts(mission).length, 1);
});

test("a human's reply calls the offer off: no pause after the 24 hours", { skip }, () => {
  const { mission } = bound("15 days");
  psql(offerSql);
  // What heardHuman writes.
  psql(`update mission_channels set last_human_at = now(), idle_warned_at = null where mission_id = '${mission}'`);
  psql(`update mission_channels set last_human_at = now() - interval '1 hour' where mission_id = '${mission}'`);
  assert.deepEqual(only(psql(pauseSql), mission), []);
  assert.deepEqual(only(psql(offerSql), mission), []);
  assert.deepEqual(state(mission), { paused: false, idlePaused: false, warned: false });
  // And the condition itself: a human after the offer, however it's left.
  const other = bound("20 days", "idle_warned_at = now() - interval '2 days'");
  psql(`update mission_channels set last_human_at = now() - interval '1 day' where mission_id = '${other.mission}'`);
  assert.deepEqual(only(psql(pauseSql), other.mission), []);
});

test("the pause 24 hours after the offer, with its exact words, once under racing sweeps", { skip }, async () => {
  const early = bound("15 days", "idle_warned_at = now() - interval '23 hours 59 minutes'");
  assert.deepEqual(only(psql(pauseSql), early.mission), []);
  assert.equal(state(early.mission).paused, false);

  const { mission } = bound("15 days", "idle_warned_at = now() - interval '24 hours'");
  const outs = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(pauseSql)));
  assert.equal(outs.flatMap((o) => only(o, mission)).length, 1);
  assert.deepEqual(state(mission), { paused: true, idlePaused: true, warned: true });
  const queued = posts(mission);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "root");
  assert.equal(queued[0].text, "Paused: no one has replied for 2 weeks. @Outrunner resume to continue.");
  assert.match(queued[0].key, /^idle_pause:/);
  // Paused now: neither sweep takes it again.
  assert.deepEqual(only(psql(pauseSql), mission), []);
  assert.deepEqual(only(psql(offerSql), mission), []);
});

test("a binding a person paused isn't swept", { skip }, () => {
  const quiet = bound("60 days", "paused = true");
  const offered = bound("60 days", "paused = true, idle_warned_at = now() - interval '5 days'");
  assert.deepEqual(only(psql(offerSql), quiet.mission), []);
  assert.deepEqual(only(psql(pauseSql), offered.mission), []);
  assert.equal(state(quiet.mission).idlePaused, false);
  assert.equal(state(offered.mission).idlePaused, false);
  assert.deepEqual(posts(quiet.mission), []);
  assert.deepEqual(posts(offered.mission), []);
});

test("a rebind starts fresh", { skip }, () => {
  const { mission, channel } = bound("15 days", "paused = true, idle_paused = true, idle_warned_at = now() - interval '2 days'");
  const org = psql(`select org_id from mission_channels where mission_id = '${mission}'`);
  psql(`delete from mission_channels where mission_id = '${mission}'`);
  psql(`insert into mission_channels (mission_id, org_id, slack_team_id, channel_id) values ('${mission}', '${org}', 'T1', '${channel}')`);
  assert.deepEqual(state(mission), { paused: false, idlePaused: false, warned: false });
  assert.equal(psql(`select now() - last_human_at < interval '1 minute' from mission_channels where mission_id = '${mission}'`), "t");
  assert.deepEqual(only(psql(offerSql), mission), []);
});
