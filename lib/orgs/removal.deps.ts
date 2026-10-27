/**
 * Real wiring for what becomes of a removed member's sessions
 * (lib/orgs/removal.ts). The member can't reach them any more, so everything
 * here is the service role's.
 */

import { closeIntervalOf, markStoppedIfReady } from "@/lib/billing/metering-store";
import { ownSandboxKeys } from "@/lib/db/credentials";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { computerMadeBy, providerNamed } from "@/lib/runtime/sandbox-choice";
import type { ProviderName } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { type Removal, type RemovalDeps, type RemovedBox, settleRemoval } from "@/lib/orgs/removal";

type Box = RemovedBox & { ownerId: string; provider: ProviderName | null };

function deps(provider: ComputerRuntimeProvider): RemovalDeps {
  const supabase = createSupabaseAdminClient();
  const madeBy = new Map<string, Box>();
  // The provider that made a box, which a member's own Daytona or Modal may
  // be rather than the deployment's.
  const maker = (box: Box) => {
    const name = computerMadeBy({ provider: box.provider });
    const found = name === provider.name ? provider : providerNamed(name, ownSandboxKeys(box.ownerId));
    if (!found || !isComputerProvider(found)) throw new Error(`Box ${box.id} is ${name}'s, which can't be reached`);
    return found;
  };
  return {
    now: () => new Date(),
    async stillRemoved(removal) {
      const { data, error } = await supabase
        .from("organization_removals")
        .select("user_id")
        .eq("org_id", removal.orgId)
        .eq("user_id", removal.userId)
        .maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    async boxes(removal) {
      const { data, error } = await supabase
        .from("runtime_computers")
        .select("id, owner_id, daytona_sandbox_id, status, pooled, provider")
        .eq("org_id", removal.orgId)
        .eq("owner_id", removal.userId);
      if (error) throw error;
      return (data ?? []).map((row) => {
        const box: Box = {
          id: row.id,
          ownerId: row.owner_id,
          sandboxId: row.daytona_sandbox_id,
          status: row.status,
          pooled: row.pooled,
          provider: row.provider as ProviderName | null,
        };
        madeBy.set(box.id, box);
        return box;
      });
    },
    async sessions(removal) {
      const { data, error } = await supabase
        .from("workspaces")
        .select("id")
        .eq("org_id", removal.orgId)
        .eq("owner_id", removal.userId)
        .neq("status", "destroyed");
      if (error) throw error;
      return (data ?? []).map((row) => row.id);
    },
    async pause(box) {
      await maker(madeBy.get(box.id)!).pauseComputer(box.sandboxId);
      await closeIntervalOf(box.sandboxId, new Date());
      await markStoppedIfReady(box.id, box.sandboxId, "Paused: its owner left the org.");
    },
    async remove(box) {
      if (box.sandboxId) {
        await maker(madeBy.get(box.id)!).destroyComputerOrThrow(box.sandboxId);
        await closeIntervalOf(box.sandboxId, new Date());
      }
      const { error } = box.pooled
        ? await supabase.from("runtime_computers").delete().eq("id", box.id)
        : await supabase
            .from("runtime_computers")
            .update({
              status: "stopped",
              daytona_sandbox_id: null,
              agent_base_url: null,
              error_message: "Deleted: its owner left the org.",
            })
            .eq("id", box.id);
      if (error) throw error;
    },
    async end(sessionId) {
      // As ending a session does (app/api/workspaces/[id]/lifecycle): its
      // replay index goes, and the row is marked destroyed.
      const { error: snapshotError } = await supabase.from("workspace_snapshots").delete().eq("workspace_id", sessionId);
      if (snapshotError) throw snapshotError;
      const { error } = await supabase
        .from("workspaces")
        .update({
          status: "destroyed",
          sandbox_id: null,
          volume_name: null,
          worktree_path: null,
          error_message: null,
        })
        .eq("id", sessionId);
      if (error) throw error;
    },
    async forget(removal) {
      const { error } = await supabase
        .from("organization_removals")
        .delete()
        .eq("org_id", removal.orgId)
        .eq("user_id", removal.userId);
      if (error) throw error;
    },
    log: (message, error) => console.error(message, error),
  };
}

/** Stop the boxes of a member just removed from an org. Never throws. */
export async function settleNewRemoval(provider: ComputerRuntimeProvider, orgId: string, userId: string): Promise<void> {
  try {
    await settleRemoval({ orgId, userId, removedAt: new Date() }, deps(provider));
  } catch (error) {
    console.error(`Could not stop the boxes of ${userId}, removed from org ${orgId}`, error);
  }
}

/** For the reconciler's cron: every removal, its boxes kept stopped and, past
 *  keeping, its sessions ended. How many removals were looked at. */
export async function sweepRemovals(provider: ComputerRuntimeProvider): Promise<number> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_removals")
    .select("org_id, user_id, removed_at");
  if (error) throw error;
  const removals: Removal[] = (data ?? []).map((row) => ({
    orgId: row.org_id,
    userId: row.user_id,
    removedAt: new Date(row.removed_at),
  }));
  for (const removal of removals) {
    try {
      await settleRemoval(removal, deps(provider));
    } catch (sweepError) {
      console.error(`Could not settle the removal of ${removal.userId} from org ${removal.orgId}`, sweepError);
    }
  }
  return removals.length;
}
