import { sweepGcpResources } from "@/lib/runtime/gcp/cleanup";
import { NextResponse } from "next/server";

import { retireOldSlackKeys } from "@/lib/db/slack-agent";
import { billingMode } from "@/lib/billing/mode";
import { runUsageSweep } from "@/lib/billing/usage-sweep.deps";
import { runReconcile } from "@/lib/billing/reconcile-run";
import { ownSandboxKeys, renewDueModelAllowances } from "@/lib/db/credentials";
import { cronAuth } from "@/lib/cron/auth";
import { recordHeartbeat } from "@/lib/cron/heartbeat.deps";
import { errorText } from "@/lib/cron/heartbeats";
import { reportError } from "@/lib/observability/report";
import { optionalEnv } from "@/lib/env";
import { sweepFollowUps } from "@/lib/github/followups.deps";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider, platformComputerProviders } from "@/lib/runtime/provider";
import { providerNamed } from "@/lib/runtime/sandbox-choice";
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
 * busy account's hours against its plan and its admins' controls
 * (lib/billing/usage-sweep.ts), for
 * the Cloudflare cron (cloudflare/worker.ts, every 2 minutes). Not a user's
 * route: it takes only BILLING_CRON_SECRET, as a bearer token. Answers what
 * the run did.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  // Each sweep below goes on when one before it fails; what failed is
  // reported to Sentry and kept as the job's heartbeat (lib/cron).
  const failed: { step: string; error: unknown }[] = [];
  const failure = <T>(step: string, message: string, fallback: T) => (error: unknown): T => {
    console.error(message, error);
    reportError(error, { where: `reconcile:${step}` });
    failed.push({ step, error });
    return fallback;
  };
  try {
    // Its own step: a billing error (a database outage, a bad migration)
    // mustn't keep every sweep below from running, setups stuck and
    // orphaned boxes running, until billing recovers. Still a 500, below.
    const report = await runReconcile().catch(failure("metering", "Metering reconcile failed; running the other sweeps anyway", null));
    // Its own step: a failure here doesn't hide what the reconciler did.
    const allowancesRenewed =
      billingMode() === "stripe"
        ? await renewDueModelAllowances().catch(failure("allowances", "Renewing model allowances failed", null))
        : 0;
    // Its own step too: pooled boxes nothing else will delete (a refill a
    // restart cut off, a failed refill's leftover box).
    const provider = getRuntimeProvider();
    const poolsSwept = isComputerProvider(provider)
      ? await sweepAbandonedPools(provider).catch(failure("pools", "Sweeping abandoned pooled boxes failed", null))
      : 0;
    // Each of Outrunner's backends' pre-warms, the one the deployment moved
    // from too: a row names the provider that made its box.
    const intentWarmsPaused = isComputerProvider(provider)
      ? await sumEach(platformComputerProviders(), (each) => sweepExpiredIntentWarmups(each)).catch(failure("intentWarmups", "Pausing expired session pre-warms failed", null))
      : 0;
    // And the boxes and sessions of members who left an org: stopped, and
    // 30 days on deleted (lib/orgs/removal.ts).
    const removalsSettled = isComputerProvider(provider)
      ? await sweepRemovals(provider).catch(failure("removals", "Settling removed members' sessions failed", null))
      : 0;
    // And automations' runs a restart cut off mid-setup, said as such.
    const runsSwept = await sweepStalledRuns().catch(failure("stalledRuns", "Sweeping stalled automation runs failed", null));
    // And runs' checks no review closed within the hour.
    const checksClosed = await sweepOpenChecks().catch(failure("openChecks", "Closing automation runs' open checks failed", null));
    // And sessions whose setup a restart cut off, failed with why.
    const setupsFailed = await sweepInterruptedSetups().catch(failure("interruptedSetups", "Failing interrupted session setups failed", null));
    // And sessions a lifecycle step (archive, restore, resume, suspend,
    // delete) was cut off in, back where it started, saying so.
    const transitionsEnded = await sweepInterruptedTransitions().catch(failure("interruptedTransitions", "Ending interrupted lifecycle steps failed", null));
    // And boxes claimed by a provision a restart cut off, let go of so the
    // next open starts them again; one brought back part way is paused, as
    // its row now says.
    const boxClaimsReleased = isComputerProvider(provider)
      ? await sweepAbandonedBoxClaims()
          .then(async ({ released, stopped }) => {
            for (const { sandboxId, provider: madeBy, ownerId } of stopped) {
              // With the provider that made it: the deployment's, the one it
              // moved from, or the owner's own.
              const name = madeBy ?? provider.name;
              const maker = name === provider.name ? provider : providerNamed(name, ownSandboxKeys(ownerId));
              if (!maker || !isComputerProvider(maker)) {
                console.error(`Could not pause box ${sandboxId}, let go of mid-provision: ${name} can't be reached`);
                continue;
              }
              await maker.pauseComputer(sandboxId).catch((error: unknown) =>
                console.error(`Could not pause box ${sandboxId}, let go of mid-provision`, error),
              );
            }
            return released;
          })
          .catch(failure("boxClaims", "Letting go of abandoned box claims failed", null))
      : 0;
    // And the deployment's boxes something dropped without deleting: no row
    // names them, so nothing above would ever stop them.
    const gcpResourcesDeleted = await sweepGcpResources().catch(failure("gcpResources", "Could not reconcile recorded GCP resources.", null));
    const orphans = await sweepOrphanedBoxes().catch(failure("orphans", "Deleting orphaned boxes failed", null));
    // And the GitHub loop's follow-ups (CI failing, reviews) that no
    // webhook's own wait sent: a restart cut it short (lib/github/followups.ts).
    const githubFollowUps = await sweepFollowUps().catch(failure("githubFollowUps", "Sending GitHub follow-ups failed", null));
    // And the Slack agent's old keys of its own, unread since it runs on the
    // org's (lib/db/slack-agent.ts): turned off on OpenRouter, a few a run.
    const slackKeysRetired = await retireOldSlackKeys().catch(failure("slackKeys", "Retiring the Slack agent's old keys failed", null));
    // And each busy account's hours against its plan and its admins'
    // controls: alerts emailed, and its boxes paused at its plan's hours or
    // its admins' limit (lib/billing/usage-sweep.ts).
    const usage = isComputerProvider(provider)
      ? await runUsageSweep(provider).catch(failure("usage", "Sweeping org usage failed", null))
      : null;
    await recordHeartbeat(
      "reconcile",
      failed.length ? new Error(`Failed: ${failed.map(({ step, error }) => `${step} (${errorText(error)})`).join("; ")}`) : undefined,
    );
    return NextResponse.json({
      ...(report ?? { error: "Reconcile failed." }),
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
    }, { status: report ? 200 : 500 });
  } catch (error) {
    console.error("Reconcile failed", error);
    reportError(error, { where: "reconcile" });
    await recordHeartbeat("reconcile", error);
    return NextResponse.json({ error: "Reconcile failed." }, { status: 500 });
  }
}

/** `sweep` over each provider in turn, its counts added up. One failing
 *  doesn't stop the others; it is logged, and the total is what the rest did. */
async function sumEach<T>(items: readonly T[], sweep: (item: T) => Promise<number>): Promise<number> {
  let total = 0;
  for (const item of items) {
    total += await sweep(item).catch((error: unknown) => {
      console.error("A provider's sweep failed", error);
      return 0;
    });
  }
  return total;
}
