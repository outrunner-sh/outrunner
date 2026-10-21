"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useNow } from "@/hooks/use-now";
import type { ProvisionPhase, Workspace } from "@/lib/runtime/types";
import { isSettingUp, setupState } from "@/lib/session/provisioning";

const POLL_MS = 2000;

export type WorkspaceSetupResult = {
  state: "running" | "stalled" | "ended";
  /** The current provisioning phase, if available from the backend. */
  phase: ProvisionPhase | null;
  /** Whether the workspace has a Runtime Computer (faster provisioning). */
  hasComputer: boolean;
};

/**
 * Where a new cloud session's setup stands, for its page: it opens before the
 * box is ready. While setup runs, the session's status is polled, and the page
 * re-read once it ends — ready or failed — so the session attaches, or says
 * why it didn't, without a reload.
 */
export function useWorkspaceSetup(
  workspace: Pick<Workspace, "id" | "status" | "createdAt">,
  /** Off for a session on this Mac, which the server doesn't set up. */
  cloud: boolean,
): WorkspaceSetupResult {
  const router = useRouter();
  // Ticks only matter while setting up: they move a long setup to "stalled".
  const now = useNow(isSettingUp(workspace.status) ? POLL_MS : 60_000);
  const state = cloud ? setupState(workspace, now) : "ended";
  const running = state === "running";

  const [phase, setPhase] = useState<ProvisionPhase | null>(null);
  // Track whether we've seen the "allocate" phase - if not, computer already existed
  const [sawAllocate, setSawAllocate] = useState(false);

  useEffect(() => {
    if (!running) return;
    let live = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/workspaces/${workspace.id}/status`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json().catch(() => ({}))) as {
          status?: Workspace["status"];
          phase?: ProvisionPhase | null;
        };
        if (!live) return;
        if (body.phase) {
          setPhase(body.phase);
          // If we see allocate phase, it means a new computer is being provisioned
          if (body.phase === "allocate") setSawAllocate(true);
        }
        if (body.status && !isSettingUp(body.status)) router.refresh();
      } catch {
        // Offline for a moment: the next tick asks again.
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void poll(), POLL_MS);
    // Poll immediately on mount to get the current phase
    void poll();
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [running, workspace.id, router]);

  // Computer already existed if we have a phase but never saw allocate
  const hasComputer = phase !== null && !sawAllocate;

  return { state, phase, hasComputer };
}
