"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { localAgentRequest, type LocalTarget } from "@/lib/desktop/local-runtime";
import type { Project } from "@/lib/runtime/types";

type CreateResponse = {
  workspace?: { id: string; projectId?: string; repoFullName?: string; branch?: string; baseBranch?: string };
  error?: string;
};

/** A session on this Mac: which Mac, and the clone it branches from. */
export type LocalCreate = { deviceId: string; repoPath: string };

/** Tell the server what the app just did on this Mac (see /api/workspaces/[id]/local). */
async function reportLocal(workspaceId: string, event: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/workspaces/${workspaceId}/local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(result.error ?? "Could not record the local session.");
  }
}

/**
 * The Mac half of creating a local workspace, once the server has its row:
 * the worktree off the user's clone, then Claude. Either failing is recorded on
 * the row so it never sits in "provisioning".
 */
async function provisionLocal(
  workspace: Required<NonNullable<CreateResponse["workspace"]>>,
  local: LocalCreate,
): Promise<void> {
  const target: LocalTarget = { workspaceId: workspace.id, projectId: workspace.projectId };
  try {
    const created = await localAgentRequest<{ worktree: string }>(target, "POST", "/workspaces", {
      workspaceId: workspace.id,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch,
      baseBranch: workspace.baseBranch,
      repoPath: local.repoPath,
    });
    await localAgentRequest(target, "POST", `/workspaces/${workspace.id}/start`);
    await reportLocal(workspace.id, { event: "ready", worktreePath: created.worktree });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the local session.";
    await reportLocal(workspace.id, { event: "failed", error: message }).catch(() => {});
    throw new Error(message);
  }
}

/**
 * The new-session creation logic, shared by the full-page creator and the home
 * modal so the fetch + navigate lives in one place. Owns the selected project
 * and the in-flight/error state; the caller supplies the layout.
 */
export function useCreateSession(projects: Project[], initialProjectId?: string) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(
    initialProjectId && projects.some((p) => p.id === initialProjectId)
      ? initialProjectId
      : (projects[0]?.id ?? ""),
  );
  const [message, setMessage] = useState<string | null>(null);
  // Set when the failure is something the user fixes in settings, so the error
  // can offer the way out instead of only naming the problem.
  const [messageHref, setMessageHref] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const selected = projects.find((project) => project.id === projectId);

  /** Create a workspace — in the cloud, or on this Mac when `local` is given. */
  function create(prompt: string, attachmentIds: string[] = [], local?: LocalCreate) {
    if (!selected) return;
    startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      if (local && attachmentIds.length > 0) {
        // The server delivers attachments, and it cannot reach this Mac.
        setMessage("Attachments can't be sent to a local session yet. Remove them and try again.");
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Attachments are not sent here: the workspace has no box yet. They
          // ride the redirect and are delivered with the first prompt.
          body: JSON.stringify(
            local ? { branch: "", location: "local", deviceId: local.deviceId } : { branch: "" },
          ),
        });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Could not start the session. Please try again.");
        // 409 is the precondition family: a missing Claude credential or GitHub
        // connection. Both are fixed in the same place.
        if (response.status === 409 && !local) setMessageHref("/settings/credentials");
        return;
      }
      if (local) {
        const workspace = result.workspace;
        if (!workspace.projectId || !workspace.repoFullName || !workspace.branch || !workspace.baseBranch) {
          setMessage("Could not start the session. Please try again.");
          return;
        }
        try {
          await provisionLocal(workspace as Required<typeof workspace>, local);
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Could not start the local session.");
          router.refresh(); // the failed workspace now shows in the sidebar
          return;
        }
      }
      const params = new URLSearchParams();
      if (prompt.trim()) params.set("prompt", prompt.trim());
      for (const id of attachmentIds) params.append("attachment", id);
      const query = params.size > 0 ? `?${params}` : "";
      router.push(`/workspaces/${result.workspace.id}${query}`);
      router.refresh();
    });
  }

  return { projectId, setProjectId, selected, isCreating, message, messageHref, create };
}
