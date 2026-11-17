import { setTimeout } from "node:timers/promises";
import { tick } from "./tick.mjs";

const secret = process.env.BILLING_CRON_SECRET;
if (!secret) throw new Error("BILLING_CRON_SECRET is required");
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

while (!stop.signal.aborted) {
  const started = Date.now();
  const results = await tick(secret, process.env.OUTRUNNER_CRON_ORIGIN || "http://app:8080");
  for (const result of results) console.log(`${result.path}: ${result.status ?? "request failed"}`);
  if (stop.signal.aborted) break;
  try {
    await setTimeout(Math.max(0, 120_000 - (Date.now() - started)), undefined, { signal: stop.signal });
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  }
}
