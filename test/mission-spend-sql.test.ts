/**
 * Mission spend's SQL (20261112160000_mission_spend.sql), run on a real
 * Postgres: each call counted once however often and however concurrently
 * it's recorded, periods split at UTC midnight and Monday, and reservations
 * that are idempotent, serialized under the Mission's lock, and never drop
 * what's owed. Needs MISSIONS_PG (as test/missions-sql.test.ts); skipped
 * without one.
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
const name = `mission_spend_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

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

function mission(): string {
  return psql(`insert into workspaces (owner_id, kind, status) values ('${OWNER}', 'mission', 'ready') returning id`);
}

function ship(missionId: string): string {
  return psql(`insert into workspaces (owner_id, parent_mission_id, status) values ('${OWNER}', '${missionId}', 'ready') returning id`);
}

type Call = {
  usage_ref: string;
  mission_id: string;
  workspace_id?: string | null;
  source?: string;
  occurred_at?: string;
  model?: string;
  output_tokens?: number;
  coverage: "reported" | "estimated" | "unavailable";
  usd_reported?: number;
  usd_estimated?: number;
  cost_basis?: string;
};

function recordSql(calls: Call[]): string {
  const json = JSON.stringify(calls.map((c) => ({ source: "session", occurred_at: "2026-11-12T10:00:00Z", ...c }))).replace(/'/g, "''");
  return `select record_mission_usage('${json}'::jsonb)`;
}

const record = (calls: Call[]) => Number(psql(recordSql(calls)));

function row(ref: string): string {
  return psql(`select mission_id || '|' || output_tokens || '|' || coverage || '|' || coalesce(usd_reported::text, '-') || '|' || coalesce(usd_estimated::text, '-') from mission_usage where usage_ref = '${ref}'`);
}

function totals(missionId: string, from: string, to: string) {
  const [reported, reportedCalls, estimated, estimatedCalls, unavailable] = psql(
    `select reported_usd, reported_calls, estimated_usd, estimated_calls, unavailable_calls from mission_usage_totals('${missionId}', '${from}', '${to}')`,
  ).split("|");
  return { reported: Number(reported), reportedCalls: Number(reportedCalls), estimated: Number(estimated), estimatedCalls: Number(estimatedCalls), unavailable: Number(unavailable) };
}

// ---------------------------------------------------------------------------
// Usage: once per call
// ---------------------------------------------------------------------------

test("a call recorded again counts once, keeping the reading with the most tokens", { skip }, () => {
  const m = mission();
  const s = ship(m);
  const ref = `claude:${randomUUID()}`;
  assert.equal(record([{ usage_ref: ref, mission_id: m, workspace_id: s, output_tokens: 10, coverage: "estimated", usd_estimated: 0.1, cost_basis: "b1" }]), 1);
  // The same reading again, and an earlier one with fewer tokens: nothing new.
  assert.equal(record([{ usage_ref: ref, mission_id: m, workspace_id: s, output_tokens: 10, coverage: "estimated", usd_estimated: 0.1, cost_basis: "b1" }]), 0);
  record([{ usage_ref: ref, mission_id: m, workspace_id: s, output_tokens: 4, coverage: "estimated", usd_estimated: 0.04, cost_basis: "b1" }]);
  assert.equal(row(ref), `${m}|10|estimated|-|0.10000000`);
  // A later record of the same reply, with more: taken.
  record([{ usage_ref: ref, mission_id: m, workspace_id: s, output_tokens: 30, coverage: "estimated", usd_estimated: 0.3, cost_basis: "b1" }]);
  assert.equal(row(ref), `${m}|30|estimated|-|0.30000000`);
  assert.equal(psql(`select count(*) from mission_usage where usage_ref = '${ref}'`), "1");
});

test("a reported cost is never replaced by an estimate or by nothing", { skip }, () => {
  const m = mission();
  const ref = `openrouter:${randomUUID()}`;
  record([{ usage_ref: ref, mission_id: m, source: "classifier", output_tokens: 5, coverage: "reported", usd_reported: 0.002 }]);
  record([{ usage_ref: ref, mission_id: m, source: "classifier", output_tokens: 50, coverage: "estimated", usd_estimated: 0.5, cost_basis: "b" }]);
  record([{ usage_ref: ref, mission_id: m, source: "classifier", output_tokens: 50, coverage: "unavailable" }]);
  assert.equal(row(ref), `${m}|5|reported|0.00200000|-`);
  // An unavailable reading is bettered by an estimate of the same tokens.
  const other = `claude:${randomUUID()}`;
  record([{ usage_ref: other, mission_id: m, output_tokens: 7, coverage: "unavailable" }]);
  record([{ usage_ref: other, mission_id: m, output_tokens: 7, coverage: "estimated", usd_estimated: 0.07, cost_basis: "b" }]);
  assert.equal(row(other), `${m}|7|estimated|-|0.07000000`);
});

test("a call counts for one Mission only, and only a Mission", { skip }, () => {
  const a = mission();
  const b = mission();
  const ref = `claude:${randomUUID()}`;
  record([{ usage_ref: ref, mission_id: a, output_tokens: 10, coverage: "unavailable" }]);
  // A forked transcript read in another Mission's family: still a's.
  assert.equal(record([{ usage_ref: ref, mission_id: b, output_tokens: 99, coverage: "unavailable" }]), 0);
  assert.equal(row(ref), `${a}|10|unavailable|-|-`);
  fails(recordSql([{ usage_ref: `claude:${randomUUID()}`, mission_id: ship(a), coverage: "unavailable" }]), /attributed to a Mission/);
  // Unknown is never $0: an unavailable call can't carry a cost, nor a covered one go without.
  fails(recordSql([{ usage_ref: `claude:${randomUUID()}`, mission_id: a, coverage: "unavailable", usd_estimated: 0, cost_basis: "b" }]), /cost_matches_coverage/);
  fails(recordSql([{ usage_ref: `claude:${randomUUID()}`, mission_id: a, coverage: "reported" }]), /cost_matches_coverage/);
});

test("the same calls recorded by racing reads count once", { skip }, async () => {
  const m = mission();
  const calls: Call[] = Array.from({ length: 20 }, (_, i) => ({
    usage_ref: `claude:race-${m}-${i}`,
    mission_id: m,
    output_tokens: 10,
    coverage: "estimated",
    usd_estimated: 0.01,
    cost_basis: "b",
  }));
  const made = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(recordSql(calls))));
  assert.equal(made.reduce((sum, n) => sum + Number(n), 0), 20, "each call new to exactly one of the racers");
  const t = totals(m, "2026-11-12", "2026-11-13");
  assert.equal(t.estimatedCalls, 20);
  assert.equal(t.estimated, 0.2);
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

test("totals split at UTC midnight and at Monday 00:00 UTC", { skip }, () => {
  const m = mission();
  const at = (ref: string, when: string, usd: number) => ({ usage_ref: `${ref}-${m}`, mission_id: m, occurred_at: when, coverage: "reported" as const, usd_reported: usd });
  record([
    at("sun-late", "2026-11-15T23:59:59.999Z", 1),
    at("mon-start", "2026-11-16T00:00:00Z", 2),
    at("mon-noon", "2026-11-16T12:00:00Z", 4),
    at("prev-week", "2026-11-09T00:00:00Z", 8),
  ]);
  assert.equal(totals(m, "2026-11-15", "2026-11-16").reported, 1, "Sunday");
  assert.equal(totals(m, "2026-11-16", "2026-11-17").reported, 6, "Monday");
  assert.equal(totals(m, "2026-11-09", "2026-11-16").reported, 9, "the week Sunday ends");
  assert.equal(totals(m, "2026-11-16", "2026-11-23").reported, 6, "the week Monday starts");
});

test("totals keep coverages apart, and count what's unknown", { skip }, () => {
  const m = mission();
  record([
    { usage_ref: `r-${m}`, mission_id: m, coverage: "reported", usd_reported: 0.5 },
    { usage_ref: `e-${m}`, mission_id: m, coverage: "estimated", usd_estimated: 0.25, cost_basis: "b1" },
    { usage_ref: `e2-${m}`, mission_id: m, coverage: "estimated", usd_estimated: 0.25, cost_basis: "b2" },
    { usage_ref: `u-${m}`, mission_id: m, coverage: "unavailable" },
  ]);
  assert.deepEqual(totals(m, "2026-11-12", "2026-11-13"), { reported: 0.5, reportedCalls: 1, estimated: 0.5, estimatedCalls: 2, unavailable: 1 });
  assert.equal(psql(`select cost_bases from mission_usage_totals('${m}', '2026-11-12', '2026-11-13')`), "{b1,b2}");
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

function reservation(sql: string) {
  const [state, amount, settled, , replayed, held, uncertain] = psql(sql).split("|");
  return { state, amount: Number(amount), settled: settled === "" ? null : Number(settled), replayed: replayed === "t", held: Number(held), uncertain: Number(uncertain) };
}

test("a reserve is idempotent per operation: the first one stands", { skip }, () => {
  const m = mission();
  assert.deepEqual(reservation(`select * from reserve_mission_spend('${m}', 'op', 1.5, 600)`), {
    state: "held", amount: 1.5, settled: null, replayed: false, held: 1.5, uncertain: 0,
  });
  assert.deepEqual(reservation(`select * from reserve_mission_spend('${m}', 'op', 9, 600)`), {
    state: "held", amount: 1.5, settled: null, replayed: true, held: 1.5, uncertain: 0,
  });
  // The same operation id on another Mission is that Mission's own.
  const other = mission();
  assert.equal(reservation(`select * from reserve_mission_spend('${other}', 'op', 2, 600)`).replayed, false);
  fails(`select * from reserve_mission_spend('${ship(m)}', 'x', 1, 60)`, /mission_not_found/);
  fails(`select * from reserve_mission_spend('${m}', 'neg', -1, 60)`, /non-negative/);
  fails(`select * from reserve_mission_spend('${m}', 'zero-time', 1, 0)`, /positive time/);
});

test("racing reserves: one reservation per operation, and every hold counted", { skip }, async () => {
  const m = mission();
  const same = await Promise.all(Array.from({ length: 8 }, (_, i) => psqlAsync(`select replayed, amount_usd from reserve_mission_spend('${m}', 'same', ${i + 1}, 600)`)));
  assert.equal(same.filter((r) => r.startsWith("f|")).length, 1, "exactly one made it");
  assert.equal(new Set(same.map((r) => r.split("|")[1])).size, 1, "all see the one that was made");
  await Promise.all(Array.from({ length: 10 }, (_, i) => psqlAsync(`select 1 from reserve_mission_spend('${m}', 'op-${i}', 0.5, 600)`)));
  const winner = Number(same[0].split("|")[1]);
  assert.equal(Number(psql(`select held_usd from mission_spend_liability('${m}')`)), winner + 5);
  assert.equal(psql(`select count(*) from mission_spend_reservations where mission_id = '${m}'`), "11");
});

test("a hold that lapses becomes uncertain liability, never dropped; a renew holds it again, never lower", { skip }, () => {
  const m = mission();
  reservation(`select * from reserve_mission_spend('${m}', 'op', 2, 600)`);
  psql(`update mission_spend_reservations set expires_at = now() - interval '1 second' where mission_id = '${m}'`);
  // Seen lapsed even before any change takes the lock.
  assert.equal(psql(`select held_usd || '|' || uncertain_usd from mission_spend_liability('${m}')`), "0|2.00000000");
  const other = reservation(`select * from reserve_mission_spend('${m}', 'other', 1, 600)`);
  assert.deepEqual([other.held, other.uncertain], [1, 2]);
  assert.equal(psql(`select state from mission_spend_reservations where mission_id = '${m}' and operation_id = 'op'`), "uncertain");
  // Renewed: held again, at the larger of the two amounts.
  const renewed = reservation(`select * from renew_mission_spend('${m}', 'op', 1, 600)`);
  assert.deepEqual([renewed.state, renewed.amount, renewed.held, renewed.uncertain], ["held", 2, 3, 0]);
  assert.equal(reservation(`select * from renew_mission_spend('${m}', 'op', 5, 600)`).amount, 5);
  assert.equal(reservation(`select * from renew_mission_spend('${m}', 'op', null, 600)`).amount, 5);
  fails(`select * from renew_mission_spend('${m}', 'nope', 1, 60)`, /reservation_not_found/);
});

test("settling without a cost keeps the hold as uncertain; with one, releases it, once", { skip }, () => {
  const m = mission();
  reservation(`select * from reserve_mission_spend('${m}', 'op', 3, 600)`);
  const unknown = reservation(`select * from settle_mission_spend('${m}', 'op', null)`);
  assert.deepEqual([unknown.state, unknown.held, unknown.uncertain, unknown.replayed], ["uncertain", 0, 3, false]);
  // Asked again, still owed.
  assert.equal(reservation(`select * from settle_mission_spend('${m}', 'op', null)`).uncertain, 3);
  const known = reservation(`select * from settle_mission_spend('${m}', 'op', 1.25)`);
  assert.deepEqual([known.state, known.settled, known.held, known.uncertain, known.replayed], ["settled", 1.25, 0, 0, false]);
  // Settled stays settled: a retry, a late renew or a different cost changes nothing.
  const again = reservation(`select * from settle_mission_spend('${m}', 'op', 9)`);
  assert.deepEqual([again.state, again.settled, again.replayed], ["settled", 1.25, true]);
  const late = reservation(`select * from renew_mission_spend('${m}', 'op', 10, 600)`);
  assert.deepEqual([late.state, late.amount, late.replayed], ["settled", 3, true]);
  fails(`select * from settle_mission_spend('${m}', 'nope', 1)`, /reservation_not_found/);
});

test("racing settles and renews of one operation end settled, with nothing owed twice", { skip }, async () => {
  const m = mission();
  reservation(`select * from reserve_mission_spend('${m}', 'op', 4, 600)`);
  await Promise.all([
    ...Array.from({ length: 4 }, () => psqlAsync(`select 1 from settle_mission_spend('${m}', 'op', 2)`)),
    ...Array.from({ length: 4 }, () => psqlAsync(`select 1 from renew_mission_spend('${m}', 'op', 6, 600)`)),
  ]);
  assert.equal(psql(`select state || '|' || settled_usd from mission_spend_reservations where mission_id = '${m}'`), "settled|2.00000000");
  assert.equal(psql(`select held_usd || '|' || uncertain_usd from mission_spend_liability('${m}')`), "0|0");
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("no one but the service role reaches the tables or functions", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    for (const table of ["mission_usage", "mission_spend_reservations"]) {
      assert.equal(psql(`select has_table_privilege('${role}', '${table}', 'select')`), "f", `${role} on ${table}`);
    }
    for (const fn of [
      "record_mission_usage(jsonb)",
      "mission_usage_totals(uuid, timestamptz, timestamptz)",
      "lock_mission_for_spend(uuid)",
      "mission_spend_liability(uuid)",
      "reserve_mission_spend(uuid, text, numeric, integer)",
      "renew_mission_spend(uuid, text, numeric, integer)",
      "settle_mission_spend(uuid, text, numeric)",
    ]) {
      assert.equal(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), "f", `${role} on ${fn}`);
    }
  }
  assert.equal(psql(`select bool_and(relrowsecurity) from pg_class where relname in ('mission_usage', 'mission_spend_reservations')`), "t");
});
