"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useAppData, useViewerScope } from "@/components/app-data";
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
  failureFor,
  FAILED_CREATE,
  type FailedCreate,
  forgetRefusedSessions,
  optimisticSession,
  refusePendingSession,
  rememberPendingSession,
  sendingAgain,
  takeFailedAttachments,
  useFailedCreate,
} from "@/lib/session/pending-sessions";
import { rememberEffort } from "@/lib/session/picked-effort";
import { rememberPickedProvider } from "@/lib/session/picked-provider";
import { sendCreate } from "@/lib/session/send-create";
import { RECENT_SELECTION } from "@/lib/session/kept-selection";
import { sessionBranch } from "@/lib/session/branch-name";

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

/** The branch a session's prompt names (lib/session/branch-name.ts): a Mac
 *  session's, whose agent adds `-2`… when the checkout has that one, and the
 *  name a cloud session's page shows until the server answers with its own. */
function promptBranch(prompt: string): string {
  return sessionBranch({ prompt });
}

/**
 * The new-session creation logic: the fetch + navigate, apart from the screen
 * (NewSessionForm). Owns the selected project and the in-flight/error state;
 * the caller supplies the layout.
 */
export function useCreateSession(projects: Project[], initialProjectId?: string) {
  const viewerScope = useViewerScope();
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
   * (useFailedCreate). Navigation is immediate; the result waits for the
   * server, so the composer keeps its stored draft until creation lands and
   * restores it on refusal, even after the form unmounts.
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
    // A Send whose answer never came: this one, asking the same of the same
    // repository soon after, is that session again — its id and branch the
    // same — so a first send that landed after all is answered for rather
    // than made twice. Anything changed (the model, its effort, the item) is
    // a new session.
    const request = JSON.stringify([model?.provider ?? null, model?.id ?? null, model ? (agent ?? null) : null, effort, workItemId ?? null]);
    const again = sendingAgain(FAILED_CREATE.get()?.unsent, selected.id, request);
    FAILED_CREATE.set(null);
    forgetRefusedSessions();

    const id = again?.id ?? nextId ?? crypto.randomUUID();
    if (!again) setNextId(crypto.randomUUID());
    // Named here, as the server will, so the page shows a branch from the
    // start rather than none until the server answers; the server's own name
    // (numbered, when this one is taken) replaces it then.
    const branch = again?.branch ?? promptBranch(prompt);
    const first = newFirstPrompt(prompt, attachmentIds);
    // Before the push: its page and the sidebar open on this row.
    const held = optimisticSession({
      id,
      project: selected,
      prompt,
      branch,
      agent: agentOf(model?.provider ?? "claude", model ? agent : undefined),
      model: model ? { model, effort } : null,
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

    const failed = (error: string, action: FailedCreate["action"] = null, unsent: FailedCreate["unsent"] = null) => {
      refusePendingSession(id, error);
      forgetFirstPrompt(tabStorage(), id);
      FAILED_CREATE.set({ projectId: selected.id, prompt, attachmentIds, message: error, action, unsent });
      // Still on its page: back to this screen, which says why. Elsewhere,
      // the screen says so when next opened.
      if (window.location.pathname === href) router.replace("/new");
    };
    return (async () => {
      // The prompt goes along only to name the session, and its branch, at
      // once; no branch is sent, so the server picks a free one. The model
      // picked on this screen, who serves it, and its effort; none, the
      // server starts it on the menu's default.
      const response = await sendCreate(
        `/api/projects/${selected.id}/workspaces`,
        JSON.stringify({
          id,
          prompt,
          // The server keeps its own copy of the prompt under this key
          // (workspaces.first_prompt), with its attachments, so it still goes
          // if this tab closes while the box starts: setup delivers it once
          // the box is ready, under the same key as this tab's copy, so the
          // box gets it once from whichever arrives first.
          promptKey: first.key,
          attachmentIds,
          ...(model && { provider: model.provider, model: model.id }),
          ...(effort && { effort }),
          ...(workItemId && { workItemId }),
          ...(model && agent && { agent }),
        }),
      );
      // The session may exist though no answer said so: the next Send of the
      // same request goes out as it, which the server then answers for.
      const unsent = { id, branch, projectId: selected.id, request, at: Date.now() };
      if (!response) {
        // Nothing got through, though a send may still land.
        failed("Could not reach Outrunner. Please try again.", null, unsent);
        return false;
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
          // A 5xx can be a lost answer too — a gateway giving up on a request
          // the server went on with — so the row may have been made.
          response.status >= 500 ? unsent : null,
        );
        return false;
      }
      // The server's row now, until the sidebar's own list has it: the
      // standings poll re-reads that list when a session it hasn't got
      // appears (components/app-frame.tsx), and the page re-reads it once
      // setup ends (hooks/use-workspace-setup.ts).
      rememberPendingSession(result.workspace);
      return true;
    })();
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
    askedAgent?: AgentId,
  ): Promise<boolean> {
    const effort = startingEffort(model, pickedEffort);
    return new Promise((resolve) => startCreating(async () => {
      setMessage(null);
      setMessageAction(null);
      FAILED_CREATE.set(null);
      const workspaceId = crypto.randomUUID();
      const target = localTarget(workspaceId);
      const agent = agentOf(model?.provider ?? "claude", askedAgent);
      const fail = (error: unknown, fallback: string) => {
        setMessage(error instanceof Error ? error.message : fallback);
        if (error instanceof LocalAgentAuthError) setMessageAction({ label: "Open settings", href: error.settingsHref, kind: "step" });
        resolve(false);
      };
      try {
        await localAgentRequest(target, "POST", "/workspaces", {
          workspaceId,
          repoFullName: folder.name,
          branch: promptBranch(prompt),
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
      if (model) rememberPickedProvider(workspaceId, model.provider);
      // Local sessions have no server model row. Keep the confirmed choice
      // before navigation, including a session that has not replied yet.
      if (viewerScope && model) {
        RECENT_SELECTION.remember({ provider: model.provider, id: model.id, agent, effort: startedAt }, viewerScope);
      }
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
    // A refusal is said only under the repository it was refused in; its
    // prompt is given back whichever is picked.
    message: message ?? failureFor(failedCreate, projectId)?.message ?? null,
    messageAction: message ? messageAction : (failureFor(failedCreate, projectId)?.action ?? null),
    /** The prompt of a session the server refused, and its files, for the
     *  composer to give back. */
    refusedPrompt: failedCreate?.prompt ?? null,
    refusedAttachments: failedCreate?.attachmentIds ?? null,
    /** The composer put those files back: they aren't given back again. */
    takeRefusedAttachments: takeFailedAttachments,
    create,
    createLocal,
  };
}
