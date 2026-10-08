"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { localAgentRequest, localTarget, type LocalFolder } from "@/lib/desktop/local-runtime";
import type { Project } from "@/lib/runtime/types";
import { initialProjectId as pickInitialProject } from "@/lib/session/initial-project";

type CreateResponse = { workspace?: { id: string }; error?: string; settingsHref?: string };

/** Same shape as the server's generated branches (runtime/<time>-<id>). */
function localBranch(workspaceId: string): string {
  return `runtime/${Date.now().toString(36)}-${workspaceId.slice(0, 8)}`;
}

/**
 * The new-session creation logic, shared by the full-page creator and the home
 * modal so the fetch + navigate lives in one place. Owns the selected project
 * and the in-flight/error state; the caller supplies the layout.
 */
export function useCreateSession(projects: Project[], initialProjectId?: string) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(() => pickInitialProject(projects, initialProjectId));
  const [message, setMessage] = useState<string | null>(null);
  // Set when the failure is something the user fixes in settings, so the error
  // can offer the way out instead of only naming the problem.
  const [messageHref, setMessageHref] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const selected = projects.find((project) => project.id === projectId);

  function create(prompt: string, attachmentIds: string[] = []) {
    if (!selected) return;
    startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Attachments are not sent here: the workspace has no box yet. They
          // ride the redirect and are delivered with the first prompt.
          body: JSON.stringify({ branch: "" }),
        });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Could not start the session. Please try again.");
        // The server names the page that fixes it, when one does (a missing
        // GitHub grant is fixed by signing in again, not in Settings).
        if (result.settingsHref) setMessageHref(result.settingsHref);
        return;
      }
      const params = new URLSearchParams();
      if (prompt.trim()) params.set("prompt", prompt.trim());
      for (const id of attachmentIds) params.append("attachment", id);
      const query = params.size > 0 ? `?${params}` : "";
      router.push(`/workspaces/${result.workspace.id}${query}`);
      router.refresh();
    });
  }

  /**
   * Start a session on this Mac, in `folder`. Nothing goes to the server: the
   * app asks the agent here for the session's worktree (or the folder itself,
   * when it is not a repository) — about a second — and opens it. Claude starts
   * there, as the session page attaches, so there is nothing else to wait for.
   */
  function createLocal(prompt: string, folder: LocalFolder) {
    startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      const workspaceId = crypto.randomUUID();
      const target = localTarget(workspaceId);
      try {
        await localAgentRequest(target, "POST", "/workspaces", {
          workspaceId,
          repoFullName: folder.name,
          branch: localBranch(workspaceId),
          repoPath: folder.path,
          // By character, so the cut never splits an emoji's surrogate pair.
          title: Array.from(prompt.trim()).slice(0, 120).join(""),
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not start the local session.");
        return;
      }
      const query = prompt.trim() ? `?${new URLSearchParams({ prompt: prompt.trim() })}` : "";
      router.push(`/local/${workspaceId}${query}`);
    });
  }

  return { projectId, setProjectId, selected, isCreating, message, messageHref, create, createLocal };
}
