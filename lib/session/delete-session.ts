import { localAgentRequest, localTarget } from "@/lib/desktop/local-runtime";
import type { SessionDeletion } from "@/lib/nav/sidebar";

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
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not delete this session. Please try again.");
  }
  try {
    await localAgentRequest(localTarget(id), "POST", `/workspaces/${id}/destroy`, { workspaceId: id });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not delete this session.");
  }
}
