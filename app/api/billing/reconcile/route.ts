import { sweepGcpResources } from "@/lib/runtime/gcp/cleanup";
import { NextResponse } from "next/server";

import { retireOldSlackKeys } from "@/lib/db/slack-agent";
import { billingMode } from "@/lib/billing/mode";
import { runUsageSweep } from "@/lib/billing/usage-sweep.deps";
import { runReconcile } from "@/lib/billing/reconcile-run";
import { renewDueModelAllowances } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";
import { sweepFollowUps } from "@/lib/github/followups.deps";
import { bearerMatches } from "@/lib/http/bearer";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { sweepOrphanedBoxes } from "@/lib/runtime/orphan-boxes.deps";
import { sweepAbandonedPools, sweepExpiredIntentWarmups } from "@/lib/runtime/warm-pool.deps";
import { sweepRemovals } from "@/lib/orgs/removal.deps";
import { sweepOpenChecks } from "@/lib/automations/checks.deps";
import { sweepStalledRuns } from "@/lib/db/automation-runs";
import { sweepAbandonedBoxClaims, sweepInterruptedSetups, sweepInterruptedTransitions } from "@/lib/session/provisioning.deps";

/**
 * One reconciler run (lib/billing/reconcile.ts), the model allowances due to
 * renew for sessions already running, and the warm pool's boxes nothing else
 * will delete (lib/runtime/warm-pool.deps.ts), and the sessions whose setup a
 * restart cut off, the lifecycle steps and box claims one did too
 * (lib/session/provisioning.deps.ts), and the GitHub loop's follow-ups due
 * (lib/github/followups.deps.ts), and the deployment's
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
    const intentWarmsPaused = isComputerProvider(provider)
      ? await sweepExpiredIntentWarmups(provider).catch((error: unknown) => {
          console.error("Pausing expired session pre-warms failed", error);
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
    // And runs' checks no review closed within the hour.
    const checksClosed = await sweepOpenChecks().catch((error: unknown) => {
      console.error("Closing automation runs' open checks failed", error);
      return null;
    });
    // And sessions whose setup a restart cut off, failed with why.
    const setupsFailed = await sweepInterruptedSetups().catch((error: unknown) => {
      console.error("Failing interrupted session setups failed", error);
      return null;
    });
    // And sessions a lifecycle step (archive, restore, resume, suspend,
    // delete) was cut off in, back where it started, saying so.
    const transitionsEnded = await sweepInterruptedTransitions().catch((error: unknown) => {
      console.error("Ending interrupted lifecycle steps failed", error);
      return null;
    });
    // And boxes claimed by a provision a restart cut off, let go of so the
    // next open starts them again; one brought back part way is paused, as
    // its row now says.
    const boxClaimsReleased = isComputerProvider(provider)
      ? await sweepAbandonedBoxClaims()
          .then(async ({ released, stopped }) => {
            for (const sandboxId of stopped) {
              await provider.pauseComputer(sandboxId).catch((error: unknown) =>
                console.error(`Could not pause box ${sandboxId}, let go of mid-provision`, error),
              );
            }
            return released;
          })
          .catch((error: unknown) => {
            console.error("Letting go of abandoned box claims failed", error);
            return null;
          })
      : 0;
    // And the deployment's boxes something dropped without deleting: no row
    // names them, so nothing above would ever stop them.
    const gcpResourcesDeleted = await sweepGcpResources().catch(() => {
      console.error("Could not reconcile recorded GCP resources.");
      return null;
    });
    const orphans = await sweepOrphanedBoxes().catch((error: unknown) => {
      console.error("Deleting orphaned Daytona boxes failed", error);
      return null;
    });
    // And the GitHub loop's follow-ups (CI failing, reviews) that no
    // webhook's own wait sent: a restart cut it short (lib/github/followups.ts).
    const githubFollowUps = await sweepFollowUps().catch((error: unknown) => {
      console.error("Sending GitHub follow-ups failed", error);
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
      gcpResourcesDeleted,
      usage,
      allowancesRenewed,
      slackKeysRetired,
      githubFollowUps,
      poolsSwept,
      intentWarmsPaused,
      removalsSettled,
      runsSwept,
      checksClosed,
      setupsFailed,
      transitionsEnded,
      boxClaimsReleased,
      orphansDeleted: orphans?.deleted ?? null,
      orphansHeld: orphans?.held ?? null,
      strayBoxesPaused: orphans?.paused ?? null,
    });
  } catch (error) {
    console.error("Reconcile failed", error);
    return NextResponse.json({ error: "Reconcile failed." }, { status: 500 });
  }
}
