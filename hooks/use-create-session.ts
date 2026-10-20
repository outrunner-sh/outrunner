"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { LocalAgentAuthError, signInLocalAgent } from "@/lib/desktop/local-agent-auth";
import {
  localAgentRequest,
  localTarget,
  putOnModel,
  putOnDefaultModel,
  type LocalFolder,
  type LocalStatus,
} from "@/lib/desktop/local-runtime";
import { agentOf, type SessionModel } from "@/lib/runtime/session-models";
import type { Project } from "@/lib/runtime/types";
import { firstPromptQuery, rememberFirstPrompt, tabStorage } from "@/lib/session/first-prompt";
import { initialProjectId as pickInitialProject } from "@/lib/session/initial-project";

type CreateResponse = { workspace?: { id: string }; error?: string; settingsHref?: string };

/** Same shape as the server's generated branches (runtime/<time>-<id>). */
function localBranch(workspaceId: string): string {
  return `runtime/${Date.now().toString(36)}-${workspaceId.slice(0, 8)}`;
}

/**
 * The new-session creation logic: the fetch + navigate, apart from the screen
 * (NewSessionForm). Owns the selected project and the in-flight/error state;
 * the caller supplies the layout.
 */
export function useCreateSession(projects: Project[], initialProjectId?: string) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(() => pickInitialProject(projects, initialProjectId));
  // Repositories connected from the picker on this screen: the page's own list
  // has them only after it reloads.
  const [connected, setConnected] = useState<Project[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // Set when the failure is something the user fixes in settings, so the error
  // can offer the way out instead of only naming the problem.
  const [messageHref, setMessageHref] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const known = useMemo(
    () => [...projects, ...connected.filter((c) => !projects.some((p) => p.id === c.id))],
    [projects, connected],
  );
  const selected = known.find((project) => project.id === projectId);

  /** Run in `project`; one the page doesn't list yet was just connected. */
  function selectProject(project: Project) {
    setProjectId(project.id);
    if (known.some((p) => p.id === project.id)) return;
    setConnected((list) => [...list, project]);
    // So the rest of the page (and the next visit) lists it too.
    router.refresh();
  }

  /** Create a cloud session and open it: at once, on its setup progress, which
   *  the server runs after answering. Resolves false when it could not be
   *  created (the message says why), so the composer keeps the prompt. */
  function create(prompt: string, attachmentIds: string[] = [], model?: SessionModel): Promise<boolean> {
    if (!selected) return Promise.resolve(false);
    return new Promise((resolve) => startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The prompt and attachments are not sent here: the workspace has no
          // box yet. They ride the redirect, and wait in this tab for the
          // session to be ready (lib/session/first-prompt.ts).
          // The model picked on this screen, and who serves it; none, the
          // server starts it on the menu's default.
          body: JSON.stringify({ branch: "", ...(model && { provider: model.provider, model: model.id }) }),
        });
      } catch {
        setMessage("Could not reach Outrunner. Please try again.");
        resolve(false);
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Could not start the session. Please try again.");
        // The server names the page that fixes it, when one does (a missing
        // GitHub grant is fixed by signing in again, not in Settings).
        if (result.settingsHref) setMessageHref(result.settingsHref);
        resolve(false);
        return;
      }
      const first = { prompt, attachmentIds };
      rememberFirstPrompt(tabStorage(), result.workspace.id, first);
      router.push(`/workspaces/${result.workspace.id}${firstPromptQuery(first)}`);
      router.refresh();
      resolve(true);
    }));
  }

  /**
   * Start a session on this Mac, in `folder`. Nothing goes to the server: the
   * app asks the agent here for the session's worktree (or the folder itself,
   * when it is not a repository) — about a second — and opens it. Claude starts
   * there, as the session page attaches, so there is nothing else to wait for.
   *
   * `onOutrunnerModel` (this Mac's Claude Code isn't logged in) puts it on
   * Outrunner's model before then, so Claude starts on that with no login. A
   * session that can't be is removed again rather than left to open on a
   * login screen.
   *
   * Its agent is its model's (Codex for Codex's), signed in the way the user
   * picked for it (Settings → Providers); `status` is what the Mac app last
   * said of its agent CLIs.
   */
  function createLocal(
    prompt: string,
    folder: LocalFolder,
    onOutrunnerModel = false,
    model?: SessionModel,
    status: LocalStatus | null = null,
  ): Promise<boolean> {
    return new Promise((resolve) => startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      const workspaceId = crypto.randomUUID();
      const target = localTarget(workspaceId);
      const agent = agentOf(model?.provider ?? "claude");
      const fail = (error: unknown, fallback: string) => {
        setMessage(error instanceof Error ? error.message : fallback);
        if (error instanceof LocalAgentAuthError) setMessageHref(error.settingsHref);
        resolve(false);
      };
      try {
        await localAgentRequest(target, "POST", "/workspaces", {
          workspaceId,
          repoFullName: folder.name,
          branch: localBranch(workspaceId),
          repoPath: folder.path,
          // By character, so the cut never splits an emoji's surrogate pair.
          title: Array.from(prompt.trim()).slice(0, 120).join(""),
          // Named only for Codex: Claude Code is every agent's default.
          ...(agent !== "claude" && { agent }),
        });
      } catch (error) {
        fail(error, "Could not start the local session.");
        return;
      }
      try {
        await signInLocalAgent(workspaceId, agent, status);
      } catch (error) {
        void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
        fail(error, "Could not sign the session's agent in.");
        return;
      }
      // The model picked on this screen; without one, Outrunner's where this
      // Mac's Claude Code isn't logged in.
      if (model || onOutrunnerModel) {
        try {
          await (model ? putOnModel(workspaceId, model) : putOnDefaultModel(workspaceId));
        } catch (error) {
          void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
          fail(error, "Outrunner's models are unavailable right now.");
          return;
        }
      }
      router.push(`/local/${workspaceId}${firstPromptQuery({ prompt, attachmentIds: [] })}`);
      resolve(true);
    }));
  }

  return { projects: known, projectId, selectProject, selected, isCreating, message, messageHref, create, createLocal };
}
