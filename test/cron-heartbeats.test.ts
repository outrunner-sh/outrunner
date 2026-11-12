import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CRON_JOBS, errorText, heartbeatStatus, heartbeatWrite, STALE_AFTER_MS } from "@/lib/cron/heartbeats";

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("a job is stale with no success in 10 minutes, or none ever", () => {
  const status = heartbeatStatus(
    [
      { job: "reconcile", last_run_at: ago(60_000), last_success_at: ago(60_000), last_error: null, last_error_at: null },
      { job: "sessions", last_run_at: ago(60_000), last_success_at: ago(STALE_AFTER_MS + 1), last_error: "Error: down", last_error_at: ago(60_000) },
      { job: "someone-elses", last_run_at: null, last_success_at: ago(0), last_error: null, last_error_at: null },
    ],
    NOW,
  );
  assert.deepEqual(Object.keys(status), [...CRON_JOBS]);
  assert.equal(status.reconcile.stale, false);
  assert.equal(status.sessions.stale, true);
  assert.equal(status.sessions.lastError, "Error: down");
  // No row: never succeeded.
  assert.deepEqual(status.slack, { lastRunAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, stale: true });
});

test("a success writes only its own columns, and a failure only its own", () => {
  const at = new Date(NOW);
  assert.deepEqual(heartbeatWrite("webhooks", undefined, at), { job: "webhooks", last_run_at: at.toISOString(), last_success_at: at.toISOString() });
  assert.deepEqual(heartbeatWrite("webhooks", new TypeError("boom"), at), {
    job: "webhooks",
    last_run_at: at.toISOString(),
    last_error: "TypeError: boom",
    last_error_at: at.toISOString(),
  });
  assert.equal(errorText("x".repeat(5000)).length, 4000);
  assert.equal(errorText({ code: "PGRST" }), '{"code":"PGRST"}');
});

test("every cron route checks the secret with cronAuth and records its heartbeat", () => {
  const routes: Record<string, string> = {
    "app/api/billing/reconcile/route.ts": "reconcile",
    "app/api/integrations/slack/tick/route.ts": "slack",
    "app/api/webhooks/tick/route.ts": "webhooks",
    "app/api/automations/tick/route.ts": "automations",
    "app/api/sessions/tick/route.ts": "sessions",
    "app/api/integrations/trackers/tick/route.ts": "trackers",
  };
  for (const [file, job] of Object.entries(routes)) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(source, /const refused = cronAuth\(request\);\n\s+if \(refused\) return refused;/, file);
    assert.doesNotMatch(source, /bearerMatches/, file);
    assert.match(source, new RegExp(`(runCronJob|recordHeartbeat)\\("${job}"`), file);
  }
  // And the Worker's cron calls each of them.
  const worker = readFileSync(path.join(process.cwd(), "cloudflare/worker.ts"), "utf8");
  for (const file of Object.keys(routes)) assert.ok(worker.includes(`"${file.slice(3, -"/route.ts".length)}"`), file);
});
