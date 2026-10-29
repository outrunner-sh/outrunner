"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useAppData } from "@/components/app-data";
import type { AgentId } from "@/lib/agents/registry";
import { LocalAgentAuthError, signInLocalAgent } from "@/lib/desktop/local-agent-auth";
import {
  localAgentRequest,
  localTarget,
  putOnModel,
  putOnDefaultModel,
  type LocalFolder,
  type LocalStatus,
} from "@/lib/desktop/local-runtime";
import {
  agentOf,
  CLAUDE_DEFAULT_MODEL,
  DEFAULT_EFFORT,
  type Effort,
  runsOnOwnAccount,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";
import type { Project, Workspace } from "@/lib/runtime/types";
import {
  firstPromptQuery,
  forgetFirstPrompt,
  newFirstPrompt,
  rememberedFirstPrompt,
  rememberFirstPrompt,
  tabStorage,
} from "@/lib/session/first-prompt";
import { initialProjectId as pickInitialProject } from "@/lib/session/initial-project";
import {
  FAILED_CREATE,
  type FailedCreate,
  forgetRefusedSessions,
  optimisticSession,
  refusePendingSession,
  rememberPendingSession,
  useFailedCreate,
} from "@/lib/session/pending-sessions";
import { rememberEffort } from "@/lib/session/picked-effort";

type CreateResponse = {
  /** The new session's row, whole, so its page opens on it at once. */
  workspace?: Workspace;
  error?: string;
  settingsHref?: string;
  sessionHref?: string;
};

/** The effort a new session starts at: the one picked, where its model takes
 *  one; else none, the model's own. */
function startingEffort(model: SessionModel | undefined, effort: Effort | null): Effort | null {
  return model && effort && takesEffort(model) ? effort : null;
}

/** How many times, and how far apart, a create whose answer was lost asks
 *  whether its session was made: the request may still be finishing. */
const LOST_ANSWER_CHECKS = 3;
const LOST_ANSWER_CHECK_MS = 1_000;

/**
 * Whether the session `id` exists, for a create whose answer never came: its
 * status route answers 200 for a session of the user's and 404 for none.
 * Asked a few times, a second apart, since the create may still be making
 * it; false once it is still missing, or Outrunner can't be reached at all.
 */
async function sessionExists(id: string): Promise<boolean> {
  for (let i = 0; i < LOST_ANSWER_CHECKS; i++) {
    await new Promise((resolve) => setTimeout(resolve, LOST_ANSWER_CHECK_MS));
    try {
      const res = await fetch(`/api/workspaces/${id}/status`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      // Still unreachable: ask again.
    }
  }
  return false;
}

/** Same shape as the server's generated branches (runtime/<time>-<id>): a
 *  local session's, and a cloud session's named on Send. */
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
  // The one picked here; until then the one the form starts on, which follows
  // the list as it arrives (a cold start streams it in).
  const [pickedId, setProjectId] = useState<string | null>(null);
  const projectId = pickedId ?? pickInitialProject(projects, initialProjectId);
  // Repositories connected from the picker on this screen: the page's own list
  // has them only after it reloads.
  const [connected, setConnected] = useState<Project[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // The way out of the failure, when one page holds it: the page's label and
  // link (settings for a missing key, the session that already holds a
  // branch), so the error can offer the way out instead of only naming the
  // problem.
  // `step` is a fix to make before this session can start (settings); a
  // `refusal` points at what is in the way, and opening it starts nothing.
  const [messageAction, setMessageAction] = useState<{ label: string; href: string; kind: "step" | "refusal" } | null>(null);
  const [isCreating, startCreating] = useTransition();
  // The id the next session made here takes, and its page's frame fetched
  // ahead (router.prefetch): Send then opens that page without a round trip.
  const [nextId, setNextId] = useState<string | null>(null);
  useEffect(() => {
    if (nextId) router.prefetch(`/workspaces/${nextId}`);
  }, [nextId, router]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNextId(crypto.randomUUID());
  }, []);

  const known = useMemo(
    () => [...projects, ...connected.filter((c) => !projects.some((p) => p.id === c.id))],
    [projects, connected],
  );
  const selected = known.find((project) => project.id === projectId);
  // One of the user's sessions, for who they are and where their sessions
  // run, which the row made up on Send carries until the server's replaces it.
  const ownSession = useAppData()?.workspaces[0];
  // A session started from here that the server then refused: said here, its
  // prompt given back, until the next is started.
  const failedCreate = useFailedCreate();

  /** Run in `project`; one the page doesn't list yet was just connected. */
  function selectProject(project: Project) {
    setProjectId(project.id);
    if (known.some((p) => p.id === project.id)) return;
    setConnected((list) => [...list, project]);
    // So the rest of the page (and the next visit) lists it too.
    router.refresh();
  }

  /**
   * Create a cloud session and open it, at once: its page opens on Send, on a
   * row this screen makes for it with an id of its own, and the sidebar lists
   * it, while the server makes it behind them (lib/session/pending-sessions.ts).
   * The create call's answer then stands in for the made-up row. Should the
   * server refuse it, the session goes from the sidebar, its page gives way to
   * this screen again, and the screen says why, with the prompt given back
   * (useFailedCreate). Resolves false only when nothing was started: no
   * repository is picked.
   */
  function create(
    prompt: string,
    attachmentIds: string[] = [],
    model?: SessionModel,
    pickedEffort: Effort | null = null,
    /** The triage item it is started from: marked in progress on it. */
    workItemId?: string,
    /** The agent to run `model` in, where it isn't the model's default (one
     *  that runs it: agentOf). */
    agent?: AgentId,
  ): Promise<boolean> {
    if (!selected) return Promise.resolve(false);
    const effort = startingEffort(model, pickedEffort);
    setMessage(null);
    setMessageAction(null);
    FAILED_CREATE.set(null);
    forgetRefusedSessions();

    const id = nextId ?? crypto.randomUUID();
    setNextId(crypto.randomUUID());
    // Named here, in the server's own shape, so the page shows the branch it
    // will work on from the start rather than none until the server answers.
    const branch = localBranch(id);
    const first = newFirstPrompt(prompt, attachmentIds);
    // Before the push: its page and the sidebar open on this row.
    const held = optimisticSession({
      id,
      project: selected,
      prompt,
      branch,
      agent: agentOf(model?.provider ?? "claude", model ? agent : undefined),
      ownerId: ownSession?.ownerId ?? "",
      provider: ownSession?.provider ?? "daytona",
    });
    rememberPendingSession(held, false);
    // The prompt and attachments are not delivered from here: the session has
    // no box yet. They wait in this tab for it to be ready
    // (lib/session/first-prompt.ts); only where the tab won't keep them do
    // they ride the URL instead, which then isn't the one fetched ahead.
    rememberFirstPrompt(tabStorage(), id, first);
    const kept = rememberedFirstPrompt(tabStorage(), id) !== null;
    // None picked: the server's default, which on the user's Claude runs at
    // DEFAULT_EFFORT (a model that takes none doesn't show it).
    rememberEffort(id, model ? effort : DEFAULT_EFFORT);
    const href = `/workspaces/${id}`;
    router.push(kept ? href : `${href}${firstPromptQuery(first)}`);

    const failed = (error: string, action: FailedCreate["action"] = null) => {
      refusePendingSession(id, error);
      forgetFirstPrompt(tabStorage(), id);
      FAILED_CREATE.set({ prompt, message: error, action });
      // Still on its page: back to this screen, which says why. Elsewhere,
      // the screen says so when next opened.
      if (window.location.pathname === href) router.replace("/new");
    };
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The prompt goes along only to name the session at once. The model
          // picked on this screen, who serves it, and its effort; none, the
          // server starts it on the menu's default.
          body: JSON.stringify({
            id,
            branch,
            prompt,
            ...(model && { provider: model.provider, model: model.id }),
            ...(effort && { effort }),
            ...(workItemId && { workItemId }),
            ...(model && agent && { agent }),
          }),
        });
      } catch {
        // The answer was lost, not necessarily the session: it may have been
        // made before the connection went. The id is this screen's, so ask
        // after it before taking it back — a resend would make a second one.
        if (await sessionExists(id)) {
          rememberPendingSession({ ...held, status: "provisioning" });
          return;
        }
        failed("Could not reach Outrunner. Please try again.");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        // The server names the page that fixes it, when one does (a missing
        // GitHub grant is fixed by signing in again; a taken branch, by
        // opening the session that holds it).
        failed(
          result.error ?? "Could not start the session. Please try again.",
          result.settingsHref
            ? { label: "Open settings", href: result.settingsHref, kind: "step" }
            : result.sessionHref
              ? { label: "Open that session", href: result.sessionHref, kind: "refusal" }
              : null,
        );
        return;
      }
      // The server's row now, until the sidebar's own list has it: the
      // standings poll re-reads that list when a session it hasn't got
      // appears (components/app-frame.tsx), and the page re-reads it once
      // setup ends (hooks/use-workspace-setup.ts).
      rememberPendingSession(result.workspace);
    })();
    return Promise.resolve(true);
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
   * said of its agent CLIs. `pickedEffort` goes with a model that takes one.
   */
  function createLocal(
    prompt: string,
    folder: LocalFolder,
    onOutrunnerModel = false,
    model?: SessionModel,
    status: LocalStatus | null = null,
    pickedEffort: Effort | null = null,
  ): Promise<boolean> {
    const effort = startingEffort(model, pickedEffort);
    return new Promise((resolve) => startCreating(async () => {
      setMessage(null);
      setMessageAction(null);
      FAILED_CREATE.set(null);
      const workspaceId = crypto.randomUUID();
      const target = localTarget(workspaceId);
      const agent = agentOf(model?.provider ?? "claude");
      const fail = (error: unknown, fallback: string) => {
        setMessage(error instanceof Error ? error.message : fallback);
        if (error instanceof LocalAgentAuthError) setMessageAction({ label: "Open settings", href: error.settingsHref, kind: "step" });
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
        // On Outrunner's model, or another on a key, it needs no account.
        await signInLocalAgent(workspaceId, agent, status, model ? runsOnOwnAccount(model) : !onOutrunnerModel);
      } catch (error) {
        void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
        fail(error, "Could not sign the session's agent in.");
        return;
      }
      // The model picked on this screen; without one, Outrunner's where this
      // Mac's Claude Code isn't logged in, else Opus on it.
      let startedAt = effort;
      if (model || onOutrunnerModel) {
        try {
          await (model ? putOnModel(workspaceId, model, effort) : putOnDefaultModel(workspaceId));
        } catch (error) {
          void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
          fail(error, "Outrunner's models are unavailable right now.");
          return;
        }
      } else {
        // Best effort, as on the cloud: an agent too old to switch, or to set
        // an effort, still starts the session, on Claude Code's own default.
        try {
          await putOnModel(workspaceId, CLAUDE_DEFAULT_MODEL, DEFAULT_EFFORT);
          startedAt = DEFAULT_EFFORT;
        } catch (error) {
          console.warn("A local session starts on Claude Code's own default model: the agent couldn't set Opus", error);
        }
      }
      rememberEffort(workspaceId, startedAt);
      router.push(`/local/${workspaceId}${firstPromptQuery({ prompt, attachmentIds: [] })}`);
      resolve(true);
    }));
  }

  return {
    projects: known,
    projectId,
    selectProject,
    selected,
    isCreating,
    message: message ?? failedCreate?.message ?? null,
    messageAction: message ? messageAction : (failedCreate?.action ?? null),
    /** The prompt of a session the server refused, for the composer. */
    refusedPrompt: failedCreate?.prompt ?? null,
    create,
    createLocal,
  };
}
