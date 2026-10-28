import { NextResponse } from "next/server";

import { retireOldSlackKeys } from "@/lib/db/slack-agent";
import { billingMode } from "@/lib/billing/mode";
import { runUsageSweep } from "@/lib/billing/usage-sweep.deps";
import { runReconcile } from "@/lib/billing/reconcile-run";
import { renewDueModelAllowances } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { sweepOrphanedBoxes } from "@/lib/runtime/orphan-boxes.deps";
import { sweepAbandonedPools } from "@/lib/runtime/warm-pool.deps";
import { sweepRemovals } from "@/lib/orgs/removal.deps";
import { sweepStalledRuns } from "@/lib/db/automation-runs";
import { sweepInterruptedSetups } from "@/lib/session/provisioning.deps";

/**
 * One reconciler run (lib/billing/reconcile.ts), the model allowances due to
 * renew for sessions already running, and the warm pool's boxes nothing else
 * will delete (lib/runtime/warm-pool.deps.ts), and the sessions whose setup a
 * restart cut off (lib/session/provisioning.deps.ts), and the deployment's
 * Daytona boxes no row names any more (lib/runtime/orphan-boxes.deps.ts), and
 * the Slack agent's old keys of its own (lib/db/slack-agent.ts), and each
 * busy team org's hours against its admins' controls
 * (lib/billing/usage-sweep.ts), for
 * the Cloudflare cron (cloudflare/worker.ts, every 2 minutes). Not a user's
 * route: it takes only BILLING_CRON_SECRET, as a bearer token. Answers what
 * the run did.
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
    // And the deployment's boxes something dropped without deleting: no row
    // names them, so nothing above would ever stop them.
    const orphans = await sweepOrphanedBoxes().catch((error: unknown) => {
      console.error("Deleting orphaned Daytona boxes failed", error);
      return null;
    });
    // And the Slack agent's old keys of its own, unread since it runs on the
    // org's (lib/db/slack-agent.ts): turned off on OpenRouter, a few a run.
    const slackKeysRetired = await retireOldSlackKeys().catch((error: unknown) => {
      console.error("Retiring the Slack agent's old keys failed", error);
      return null;
    });
    // And each busy team org's hours against its admins' controls: alerts
    // emailed, and its boxes paused at its limit (lib/billing/usage-sweep.ts).
    const usage = isComputerProvider(provider)
      ? await runUsageSweep(provider).catch((error: unknown) => {
          console.error("Sweeping org usage failed", error);
          return null;
        })
      : null;
    return NextResponse.json({
      ...report,
      usage,
      allowancesRenewed,
      slackKeysRetired,
      poolsSwept,
      removalsSettled,
      runsSwept,
      setupsFailed,
      orphansDeleted: orphans?.deleted ?? null,
      orphansHeld: orphans?.held ?? null,
    });
  } catch (error) {
    console.error("Reconcile failed", error);
    return NextResponse.json({ error: "Reconcile failed." }, { status: 500 });
  }
}
