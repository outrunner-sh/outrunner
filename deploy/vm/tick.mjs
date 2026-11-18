import { pathToFileURL } from "node:url";

export const paths = [
  "/api/billing/reconcile",
  "/api/integrations/slack/tick",
  "/api/webhooks/tick",
  "/api/automations/tick",
  "/api/sessions/tick",
  "/api/integrations/trackers/tick",
];

// Match the existing Worker: one failed job must not prevent the other five.
// Return only status information, never response bodies or the bearer token.
export async function tick(secret, origin = "http://127.0.0.1:3000", timeoutMs = 60_000) {
  if (!secret) throw new Error("BILLING_CRON_SECRET is required");
  return Promise.all(paths.map(async (path) => {
    try {
      const response = await fetch(new URL(path, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      return { path, ok: response.ok, status: response.status };
    } catch {
      return { path, ok: false, status: null };
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.BILLING_CRON_SECRET;
  if (!secret) {
    console.error("BILLING_CRON_SECRET is required");
    process.exitCode = 1;
  } else {
    const results = await tick(secret);
    for (const result of results) console.log(`${result.path}: ${result.status ?? "request failed"}`);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  }
}
