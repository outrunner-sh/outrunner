import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { billingMode } from "@/lib/billing/mode";
import { runReconcile } from "@/lib/billing/reconcile-run";
import { renewDueModelAllowances } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { sweepAbandonedPools } from "@/lib/runtime/warm-pool.deps";
import { sweepRemovals } from "@/lib/orgs/removal.deps";
import { sweepStalledRuns } from "@/lib/db/automation-runs";
import { sweepInterruptedSetups } from "@/lib/session/provisioning.deps";

/**
 * One reconciler run (lib/billing/reconcile.ts), the model allowances due to
 * renew for sessions already running, and the warm pool's boxes nothing else
 * will delete (lib/runtime/warm-pool.deps.ts), and the sessions whose setup a
 * restart cut off (lib/session/provisioning.deps.ts), for the Cloudflare cron
 * (cloudflare/worker.ts, every 2 minutes). Not a user's route: it takes only
 * BILLING_CRON_SECRET, as a bearer token. Answers what the run did.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const report = await runReconcile();
    // Its own step: a failure here doesn't hide what the reconciler did.
    const allowancesRenewed =
      billingMode() === "stripe"
        ? await renewDueModelAllowances().catch((error: unknown) => {
            console.error("Renewing model allowances failed", error);
            return null;
          })
        : 0;
    // Its own step too: pooled boxes nothing else will delete (a refill a
    // restart cut off, a failed refill's leftover box).
    const provider = getRuntimeProvider();
    const poolsSwept = isComputerProvider(provider)
      ? await sweepAbandonedPools(provider).catch((error: unknown) => {
          console.error("Sweeping abandoned pooled boxes failed", error);
          return null;
        })
      : 0;
    // And the boxes and sessions of members who left an org: stopped, and
    // 30 days on deleted (lib/orgs/removal.ts).
    const removalsSettled = isComputerProvider(provider)
      ? await sweepRemovals(provider).catch((error: unknown) => {
          console.error("Settling removed members' sessions failed", error);
          return null;
        })
      : 0;
    // And automations' runs a restart cut off mid-setup, said as such.
    const runsSwept = await sweepStalledRuns().catch((error: unknown) => {
      console.error("Sweeping stalled automation runs failed", error);
      return null;
    });
    // And sessions whose setup a restart cut off, failed with why.
    const setupsFailed = await sweepInterruptedSetups().catch((error: unknown) => {
      console.error("Failing interrupted session setups failed", error);
      return null;
    });
    return NextResponse.json({ ...report, allowancesRenewed, poolsSwept, removalsSettled, runsSwept, setupsFailed });
  } catch (error) {
    console.error("Reconcile failed", error);
    return NextResponse.json({ error: "Reconcile failed." }, { status: 500 });
  }
}

/** Whether `header` is `Bearer <secret>`, compared in constant time. */
function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
