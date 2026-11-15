/**
 * retakeRun's statement (lib/db/automation-runs.ts) on a real Postgres: a run
 * that made nothing (failed, refused or skipped) is taken back to `started`
 * under the same dedupe key; one that made something (ready) or is under way
 * (started, queued) isn't; and of two callers racing for the same key, one
 * wins. The statement below is the one retakeRun sends through PostgREST
 * (an UPDATE … WHERE automation_id, project_id, dedupe_key and status IN
 * (failed, refused, skipped) … RETURNING id). The status constraint is the
 * real one, from 20261114200200_mission_inputs.sql. Needs MISSIONS_PG
 * (as test/mission-slack-sql.test.ts); skipped without one.
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
const name = `automation_retake_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

async function psqlAsync(sql: string): Promise<string> {
  return (await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" })).stdout.trim();
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
  // The stub's automation_runs is pared down; retakeRun's filters and sets
  // need these columns, as the real table has them.
  psql(`alter table automation_runs
    add column if not exists project_id uuid,
    add column if not exists dedupe_key text,
    add column if not exists workspace_id uuid,
    add column if not exists reason text,
    add column if not exists context jsonb,
    add column if not exists updated_at timestamptz not null default now()`);
});

after(() => {
  if (server) execFileSync("psql", [server, "-qc", `drop database if exists ${name} with (force)`]);
});

const PROJECT = "00000000-0000-0000-0000-0000000000a1";

function automation(): string {
  return psql(`insert into automations (triggers) values ('{schedule}') returning id`);
}

function runWith(a: string, key: string, status: string): string {
  return psql(
    `insert into automation_runs (automation_id, project_id, dedupe_key, trigger, status, workspace_id, reason, context)
     values ('${a}', '${PROJECT}', '${key}', 'linear.issue', '${status}', null, 'refused: approval revoked', '{"old":true}') returning id`,
  );
}

/** The statement retakeRun sends. */
function retake(a: string, key: string, event: Record<string, unknown>): string {
  return `update automation_runs
    set status = 'started', workspace_id = null, reason = null, context = '${JSON.stringify(event)}'::jsonb, updated_at = now()
    where automation_id = '${a}' and project_id = '${PROJECT}' and dedupe_key = '${key}'
      and status in ('failed', 'refused', 'skipped')
    returning id`;
}

test("SQL: a run that made nothing is taken back under its key; one that made something isn't", { skip }, () => {
  const a = automation();
  for (const status of ["failed", "refused", "skipped"]) {
    const key = `linear:agent-${status}:2`;
    const id = runWith(a, key, status);
    assert.equal(psql(retake(a, key, { delegation: key })), id, `${status} is taken back`);
    assert.equal(psql(`select status || '|' || coalesce(reason, '') || '|' || (context->>'delegation') from automation_runs where id = '${id}'`), `started||${key}`);
    // Taken: a second retake finds nothing to take.
    assert.equal(psql(retake(a, key, { delegation: key })), "");
  }
  for (const status of ["ready", "started", "queued"]) {
    const key = `linear:agent-${status}:2`;
    const id = runWith(a, key, status);
    assert.equal(psql(retake(a, key, { delegation: key })), "", `${status} isn't taken`);
    assert.equal(psql(`select status from automation_runs where id = '${id}'`), status);
  }
  // Another automation's or another key's run is never touched.
  const other = automation();
  const theirs = runWith(other, "linear:agent-x:2", "refused");
  assert.equal(psql(retake(a, "linear:agent-x:2", {})), "");
  assert.equal(psql(`select status from automation_runs where id = '${theirs}'`), "refused");
});

test("SQL: two callers racing to take back the same key: one wins", { skip }, async () => {
  const a = automation();
  for (let round = 0; round < 5; round++) {
    const key = `linear:agent-race-${round}:2`;
    const id = runWith(a, key, "refused");
    const results = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(retake(a, key, { round }))));
    assert.deepEqual(results.filter(Boolean), [id], `round ${round}: one winner`);
    assert.equal(psql(`select count(*) from automation_runs where dedupe_key = '${key}'`), "1");
  }
});
