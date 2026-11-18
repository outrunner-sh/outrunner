/**
 * Mission budgets' SQL (20261118120100_mission_budgets.sql), on a real
 * Postgres: limits and a pause written together; a pause settled only while
 * the limits are the ones decided on, so a stale check can't pause a Mission
 * whose limit was just raised; a budget-paused Mission's events held out of
 * the tick's list, not dropped, and listed again once the pause has passed;
 * and only the service role reaching any of it. Needs MISSIONS_PG (as
 * test/mission-spend-sql.test.ts); skipped without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";

let url = "";
const name = `mission_budget_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
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

const org = () => psql(`insert into organizations default values returning id`);
const mission = () => psql(`insert into workspaces (owner_id, kind, status) values ('${OWNER}', 'mission', 'ready') returning id`);
const ship = (m: string) => psql(`insert into workspaces (owner_id, parent_mission_id, status) values ('${OWNER}', '${m}', 'ready') returning id`);

const sqlNum = (n: number | null) => (n === null ? "null" : String(n));
const sqlText = (t: string | null) => (t === null ? "null" : `'${t}'`);

function setBudget(m: string, o: string, daily: number | null, weekly: number | null, pause: { period: string; until: string } | null = null) {
  psql(
    `select set_mission_budget('${m}', '${o}', ${sqlNum(daily)}, ${sqlNum(weekly)}, null, ${sqlText(pause?.period ?? null)}, ${sqlText(pause?.until ?? null)})`,
  );
}

function settle(m: string, daily: number | null, weekly: number | null, pause: { period: string; until: string } | null): string {
  return psql(
    `select settle_mission_budget_pause('${m}', ${sqlNum(daily)}, ${sqlNum(weekly)}, ${sqlText(pause?.period ?? null)}, ${sqlText(pause?.until ?? null)})`,
  );
}

const row = (m: string) =>
  psql(`select coalesce(daily_usd::text, '-') || '|' || coalesce(weekly_usd::text, '-') || '|' || coalesce(paused_period, '-') || '|' || coalesce(to_char(paused_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '-') from mission_budgets where mission_id = '${m}'`);

test("a budget's limits and pause are written together; both limits null is no budget", { skip }, () => {
  const o = org();
  const m = mission();
  setBudget(m, o, 100, 1000);
  assert.equal(row(m), "100.00|1000.00|-|-");
  // A lowered limit, with the pause it calls for, in the same write.
  setBudget(m, o, 50, 1000, { period: "day", until: "2099-01-02T00:00:00Z" });
  assert.equal(row(m), "50.00|1000.00|day|2099-01-02T00:00");
  // Raised: the pause goes with the same write.
  setBudget(m, o, 500, 1000);
  assert.equal(row(m), "500.00|1000.00|-|-");
  setBudget(m, o, null, null);
  assert.equal(row(m), "");
  // A limit is more than $0; the period is a day or a week.
  fails(`select set_mission_budget('${m}', '${o}', 0, null, null, null, null)`, /daily_usd_check|check constraint/);
  fails(`select set_mission_budget('${m}', '${o}', 10, null, null, 'month', now())`, /paused_period_check|check constraint/);
});

test("a pause is settled only while the limits are the ones decided on", { skip }, () => {
  const o = org();
  const m = mission();
  setBudget(m, o, 100, null);
  // A check that read $100: pauses.
  assert.equal(settle(m, 100, null, { period: "day", until: "2099-01-02T00:00:00Z" }), "t");
  assert.equal(row(m), "100.00|-|day|2099-01-02T00:00");
  // The owner raises it, lifting the pause in that write...
  setBudget(m, o, 200, null);
  // ...and a check that had read the old limit can't pause it again.
  assert.equal(settle(m, 100, null, { period: "day", until: "2099-01-02T00:00:00Z" }), "f");
  assert.equal(row(m), "200.00|-|-|-");
  // One on the limits as they are: applies, and again is a no-op that holds.
  assert.equal(settle(m, 200, null, { period: "week", until: "2099-01-05T00:00:00Z" }), "t");
  assert.equal(settle(m, 200, null, { period: "week", until: "2099-01-05T00:00:00Z" }), "t");
  assert.equal(row(m), "200.00|-|week|2099-01-05T00:00");
  // Lifting (a rollover that found it under its limits).
  assert.equal(settle(m, 200, null, null), "t");
  assert.equal(row(m), "200.00|-|-|-");
  // No budget: nothing to settle.
  assert.equal(settle(mission(), 100, null, { period: "day", until: "2099-01-02T00:00:00Z" }), "f");
});

test("a budget-paused Mission's events are held out of the tick's list, kept, and listed again once the pause has passed", { skip }, () => {
  const o = org();
  const paused = mission();
  const open = mission();
  for (const m of [paused, open]) {
    psql(
      `insert into mission_events (mission_id, runner_id, kind, idempotency_key, created_at) values ('${m}', '${ship(m)}', 'finished', '${randomUUID()}', now() - interval '1 hour')`,
    );
  }
  const listed = () => psql(`select string_agg(mission_id::text, ',') from missions_with_pending_events(1000)`).split(",");
  assert.ok(listed().includes(paused) && listed().includes(open));
  setBudget(paused, o, 10, null, { period: "day", until: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(!listed().includes(paused));
  assert.ok(listed().includes(open));
  // Held, not dropped.
  assert.equal(psql(`select count(*) from mission_events where mission_id = '${paused}' and delivered_at is null`), "1");
  // Its paused_until passed (the period rolled over): listed again, for
  // delivery to check the budget afresh.
  psql(`update mission_budgets set paused_until = now() - interval '1 second' where mission_id = '${paused}'`);
  assert.ok(listed().includes(paused));
  // A budget with no pause holds nothing.
  setBudget(paused, o, 10, null);
  assert.ok(listed().includes(paused));
});

test("no one but the service role reaches budgets", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(psql(`select has_table_privilege('${role}', 'mission_budgets', 'select')`), "f", role);
    for (const fn of [
      "set_mission_budget(uuid, uuid, numeric, numeric, uuid, text, timestamptz)",
      "settle_mission_budget_pause(uuid, numeric, numeric, text, timestamptz)",
      "missions_with_pending_events(integer)",
    ]) {
      assert.equal(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), "f", `${role} on ${fn}`);
    }
  }
  assert.equal(psql(`select relrowsecurity from pg_class where relname = 'mission_budgets'`), "t");
});
