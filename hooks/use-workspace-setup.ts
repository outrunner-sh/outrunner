"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useNow } from "@/hooks/use-now";
import type { Workspace } from "@/lib/runtime/types";
import { isSettingUp, setupState } from "@/lib/session/provisioning";

const POLL_MS = 2000;

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
) {
  const router = useRouter();
  // Ticks only matter while setting up: they move a long setup to "stalled".
  const now = useNow(isSettingUp(workspace.status) ? POLL_MS : 60_000);
  const state = cloud ? setupState(workspace, now) : "ended";
  const running = state === "running";

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
        const body = (await res.json().catch(() => ({}))) as { status?: Workspace["status"] };
        if (live && body.status && !isSettingUp(body.status)) router.refresh();
      } catch {
        // Offline for a moment: the next tick asks again.
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [running, workspace.id, router]);

  return state;
}
