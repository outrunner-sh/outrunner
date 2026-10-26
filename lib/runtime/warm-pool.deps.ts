/**
 * Real wiring for the warm pool (lib/runtime/warm-pool.ts). Kept apart so the
 * rules stay free of the database and unit-testable.
 */

import { randomBytes } from "node:crypto";

import { isMetered } from "@/lib/billing/metering-store";
import {
  claimPooledComputer,
  createPooledComputer,
  deletePooledComputer,
  getPooledComputer,
  markPooledFailed,
  markPooledReady,
  updateRuntimeComputer,
} from "@/lib/db/repositories";
import { ownSandboxKeys } from "@/lib/db/credentials";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerNamed } from "@/lib/runtime/sandbox-choice";
import type { Project, ProviderName } from "@/lib/runtime/types";
import { refillPool, STALE_REFILL_MS } from "@/lib/runtime/warm-pool";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Whether `provider`'s boxes are pooled: Outrunner's own, on a provider
 *  that pauses a box and brings it back on its disk. */
export function poolsBoxes(provider: ComputerRuntimeProvider): boolean {
  return provider.pausesBoxes && provider.restoresBoxes && isMetered(provider.name);
}

/** The project's pooled box for a new session to take, made by `provider`:
 *  its id, or null when there's none (and so the session makes its own). */
export async function takePooledBox(provider: ComputerRuntimeProvider, workspaceId: string): Promise<string | null> {
  if (!poolsBoxes(provider)) return null;
  try {
    return await claimPooledComputer(workspaceId, provider.name);
  } catch (error) {
    console.error(`Could not take a pooled box for ${workspaceId}`, error);
    return null;
  }
}

/** Make the project's pooled box, for its next session, when it has none.
 *  Best effort, after a session's setup: it never throws. */
export async function refillProjectPool(input: {
  provider: ComputerRuntimeProvider;
  ownerId: string;
  project: Pick<Project, "id" | "fullName">;
  githubToken?: string;
  sessionEnv: Record<string, string>;
}): Promise<void> {
  const { provider, ownerId, project } = input;
  try {
    await refillPool({
      pools: poolsBoxes(provider),
      provider: provider.name,
      pooled: () => getPooledComputer(project.id),
      claimSlot: (secret) =>
        createPooledComputer({ ownerId, projectId: project.id, provider: provider.name, agentSecret: secret }),
      make: (secret, onBox) =>
        provider.provisionComputer({
          secret,
          repoFullName: project.fullName,
          githubToken: input.githubToken,
          sessionEnv: input.sessionEnv,
          onBox,
        }),
      recordBox: (computerId, sandboxId) => updateRuntimeComputer(computerId, { daytonaSandboxId: sandboxId }),
      pause: (sandboxId) => provider.pauseComputer(sandboxId),
      ready: markPooledReady,
      failed: markPooledFailed,
      discard: (sandboxId, madeBy) => discardBox(provider, madeBy, ownerId, sandboxId),
      forget: deletePooledComputer,
      newSecret: () => randomBytes(32).toString("hex"),
      now: Date.now,
    });
  } catch (error) {
    console.error(`Could not make ${project.fullName}'s pooled box`, error);
  }
}

/** Delete a pooled box with the provider that made it. Pooled boxes are only
 *  ever the deployment's, so another maker means the deployment's provider
 *  changed: that one can't be reached from here, and its row can't help
 *  delete it, so the box is logged (to delete by hand) and let go. */
async function discardBox(
  provider: ComputerRuntimeProvider,
  madeBy: ProviderName | null,
  ownerId: string,
  sandboxId: string,
): Promise<void> {
  const maker = !madeBy || madeBy === provider.name ? provider : providerNamed(madeBy, ownSandboxKeys(ownerId));
  if (!maker || !isComputerProvider(maker)) {
    console.warn(`Pooled box ${sandboxId} on ${madeBy} can't be reached to delete it: delete it there by hand`);
    return;
  }
  await maker.destroyComputerOrThrow(sandboxId);
}

/**
 * Delete the warm pool's boxes nothing else will: a refill that died mid-way
 * (its row still "provisioning" past STALE_REFILL_MS, its box maybe running),
 * and a failed refill's leftover box (an "error" row that kept the box its
 * delete couldn't remove; maybe still running too). Pooled boxes are outside
 * metering and the reconciler, so this is what stops them. For the
 * reconciler's cron, so such a box lasts minutes, not until the project's
 * next session. A dead refill's row goes; a failed one keeps its row, for its
 * back-off, without the box. How many boxes went. A box already gone is gone.
 */
export async function sweepAbandonedPools(provider: ComputerRuntimeProvider): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const stale = new Date(Date.now() - STALE_REFILL_MS).toISOString();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("id, status, daytona_sandbox_id, provider")
    .eq("pooled", true)
    .or(`and(status.eq.provisioning,updated_at.lt.${stale}),and(status.eq.error,daytona_sandbox_id.not.is.null)`);
  if (error) throw error;
  let swept = 0;
  for (const row of data ?? []) {
    try {
      // Pooled boxes are only ever this deployment's provider's: another's
      // means the deployment moved, and its box can't be reached from here.
      if (row.daytona_sandbox_id && row.provider && row.provider !== provider.name) {
        console.warn(`Pooled box ${row.daytona_sandbox_id} on ${row.provider} can't be reached to delete it: delete it there by hand`);
      } else if (row.daytona_sandbox_id) {
        await provider.destroyComputerOrThrow(row.daytona_sandbox_id);
      }
      const { error: writeError } =
        row.status === "error"
          ? await supabase.from("runtime_computers").update({ daytona_sandbox_id: null }).eq("id", row.id).eq("pooled", true)
          : await supabase.from("runtime_computers").delete().eq("id", row.id).eq("pooled", true);
      if (writeError) throw writeError;
      swept += 1;
    } catch (sweepError) {
      console.error(`Could not sweep pooled box ${row.id}`, sweepError);
    }
  }
  return swept;
}
