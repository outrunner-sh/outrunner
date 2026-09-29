"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { Project } from "@/lib/runtime/types";

type CreateResponse = { workspace?: { id: string }; error?: string };

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
        // 409 is the precondition family: a missing Claude credential or GitHub
        // connection. Both are fixed in the same place.
        if (response.status === 409) setMessageHref("/settings/credentials");
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

  return { projectId, setProjectId, selected, isCreating, message, messageHref, create };
}
