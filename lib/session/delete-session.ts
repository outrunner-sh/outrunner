import { store, useStore } from "@/lib/client/store";
import { localAgentRequest, localTarget } from "@/lib/desktop/local-runtime";
import type { SessionDeletion } from "@/lib/nav/sidebar";

/** Sessions deleted from this page. A session's page can outlive it (kept
 *  hidden for going back to), and must then say it is gone rather than show
 *  what it last knew. */
const DELETED = store<ReadonlySet<string>>(new Set());
const NONE: ReadonlySet<string> = new Set();

export function useDeletedSession(id: string): boolean {
  return useStore(DELETED, NONE).has(id);
}

/**
 * Delete a session for good: a cloud one through the server (the lifecycle
 * route's destroy, which tears down its worktree), a local one through the
 * agent on this Mac. Throws with a sentence to show when it could not.
 */
export async function deleteSession(id: string, deletion: SessionDeletion): Promise<void> {
  if (deletion.kind === "cloud") {
    let res: Response;
    try {
      res = await fetch(`/api/workspaces/${id}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "destroy" }),
      });
    } catch {
      throw new Error("Could not reach Outrunner. Check your connection and try again.");
    }
    if (res.ok) {
      DELETED.set(new Set([...DELETED.get(), id]));
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not delete this session. Please try again.");
  }
  try {
    await localAgentRequest(localTarget(id), "POST", `/workspaces/${id}/destroy`, { workspaceId: id });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not delete this session.");
  }
}
