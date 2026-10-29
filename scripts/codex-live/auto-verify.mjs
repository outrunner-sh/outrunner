/** Operator-only, one-shot continuation. Never starts/cancels device login. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { env, root } from "./env.mjs";

const state = JSON.parse(readFileSync(root + "/state.json", "utf8"));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const gateway = "http://127.0.0.1:3410";
const resultPath = root + "/auto-verification.json";
const report = (message, details = {}) => {
  writeFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), message, ...details }), { mode: 0o600 });
  console.log(message);
};
async function status(ticket) {
  const response = await fetch(gateway + "/__test/status", {
    headers: { cookie: "codex_live_test=" + ticket.session },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Launcher unavailable");
  return (await response.json()).verification;
}
report("Armed: waiting for owner-approved connection; no login will be started.");
try {
  let ticket;
  for (;;) {
    ticket = JSON.parse(readFileSync(root + "/access.json", "utf8"));
    if (Date.now() >= ticket.expires) throw new Error("Private handoff expired; no authorization started");
    const { data, error } = await db.from("codex_connections").select("status")
      .eq("key", "org:" + state.org).maybeSingle();
    if (!error && data?.status === "connected") break;
    await delay(2000);
  }
  let verification = await status(ticket);
  // Durable claim prevents rerunning provider turns on service restart.
  writeFileSync(root + "/auto-verification.claim", new Date().toISOString(), { mode: 0o600, flag: "wx" });
  if (!verification.running && !verification.checks.length) {
    const response = await fetch(gateway + "/__test/verify", {
      method: "POST",
      headers: { origin: gateway, cookie: "codex_live_test=" + ticket.session },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Could not start prepared verification");
  }
  report("Owner connection detected: observing prepared live checks.");
  do {
    await delay(2000);
    verification = await status(ticket);
  } while (verification.running);
  report(verification.message, { checks: verification.checks });
  if (!verification.message.startsWith("All live checks passed.")) process.exit(1);

  // Finish the planned revocation check only after successful live turns/refresh.
  const cli = JSON.parse(readFileSync(root + "/cli.json", "utf8"));
  const removed = await fetch("http://127.0.0.1:3408/api/cli/codex?org=" + state.org, {
    method: "DELETE", headers: { Authorization: "Bearer " + cli.token },
    signal: AbortSignal.timeout(10000),
  });
  if (!removed.ok) throw new Error("Test disconnect failed");
  const code = await new Promise((resolve) => {
    const child = spawn("node", ["scripts/codex-live/run-verify.mjs", "--cleanup", "--check-revoked"], {
      cwd: new URL("../..", import.meta.url), stdio: ["ignore", "pipe", "ignore"],
    });
    let pending = "";
    child.stdout.on("data", (data) => {
      pending += data.toString();
      for (;;) {
        const n = pending.indexOf("\n");
        if (n < 0) break;
        const line = pending.slice(0, n);
        pending = pending.slice(n + 1);
        if (/^PASS |^FAIL /.test(line)) console.log(line.slice(0, 300));
      }
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code !== 0) throw new Error("Post-disconnect retained-grant check failed");
  report("PASS live checks and disconnect/revocation; isolated connection cleared.", { checks: verification.checks, revoked: true });
} catch (error) {
  const known = new Set(["Private handoff expired; no authorization started", "Launcher unavailable", "Could not start prepared verification", "Test disconnect failed", "Post-disconnect retained-grant check failed"]);
  report("STOP: " + (known.has(error?.message) ? error.message : "Continuation needs operator inspection; no automatic retry."));
  process.exitCode = 1;
}
