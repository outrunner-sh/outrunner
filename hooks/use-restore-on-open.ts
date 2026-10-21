"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { Workspace } from "@/lib/runtime/types";
import { SETUP_STALLS_AFTER_MS } from "@/lib/session/provisioning";
import { restoresOnOpen, restoreSession } from "@/lib/session/restore-session";

const POLL_MS = 2000;

export type RestoreOnOpen =
  | { state: "none" }
  | { state: "restoring" }
  | { state: "failed"; error: string; settingsHref: string | null; retry: (() => void) | null };

type Failure = { error: string; settingsHref: string | null; retryable: boolean };

/**
 * Restore an archived cloud session as its page opens (lib/session/
 * restore-session.ts), once per open: a failure is shown, with a way to try
 * again, rather than asked again on its own. A session already restoring (from
 * another tab, or a page reloaded midway) is watched until it ends. Either way
 * the page is re-read once it does, so the session attaches without a reload.
 */
export function useRestoreOnOpen(
  workspace: Pick<Workspace, "id" | "status" | "provider">,
  /** Off for a session on this Mac, which the server doesn't restore. */
  cloud: boolean,
): RestoreOnOpen {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  // A failure holds only while the session stays where it failed: a restore's
  // while it is archived (another tab may since have started one, refused
  // here), a stalled watch's while it is still restoring.
  const failed = failure && workspace.status === (failure.retryable ? "archived" : "restoring") ? failure : null;
  const restore = cloud && restoresOnOpen(workspace) && !failed;
  const watch = cloud && workspace.status === "restoring" && !failed;

  useEffect(() => {
    if (!restore) return;
    let live = true;
    void restoreSession(workspace.id).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) setFailure({ error: outcome.error, settingsHref: outcome.settingsHref, retryable: true });
      // Live, or not: either way the row has moved on.
      router.refresh();
    });
    return () => {
      live = false;
    };
  }, [restore, workspace.id, router]);

  useEffect(() => {
    if (!watch) return;
    let live = true;
    const since = Date.now();
    const poll = async () => {
      if (!live) return;
      if (Date.now() - since >= SETUP_STALLS_AFTER_MS) {
        // A restore whose server stopped midway never ends: say so, rather
        // than spin for good.
        setFailure({
          error: "Restoring this session is taking far longer than it should. Reload the page to check on it.",
          settingsHref: null,
          retryable: false,
        });
        return;
      }
      try {
        const res = await fetch(`/api/workspaces/${workspace.id}/status`, { cache: "no-store" });
        const body = res.ok ? ((await res.json().catch(() => ({}))) as { status?: Workspace["status"] }) : {};
        if (live && body.status && body.status !== "restoring") router.refresh();
      } catch {
        // Offline for a moment: the next tick asks again.
      }
    };
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [watch, workspace.id, router]);

  if (failed) {
    return {
      state: "failed",
      error: failed.error,
      settingsHref: failed.settingsHref,
      retry: failed.retryable ? () => setFailure(null) : null,
    };
  }
  return restore || watch ? { state: "restoring" } : { state: "none" };
}
