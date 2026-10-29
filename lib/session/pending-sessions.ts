"use client";

import type { AgentId } from "@/lib/agents/registry";
import { store, useStore } from "@/lib/client/store";
import { sessionTitle } from "@/lib/nav/session-title";
import type { Project, ProviderName, Workspace } from "@/lib/runtime/types";

/**
 * The sessions this tab has just started, by id, from the moment Send is
 * pressed until the sidebar's own data catches up.
 *
 * A new session's page opens on Send, before the server has made its row
 * (hooks/use-create-session.ts): the row held here is the one the screen made
 * for it — unconfirmed — and then the one the create call answered with. The
 * layout's data, which is what a session's page and the sidebar open from,
 * was read before either existed; without this the page would wait for the
 * server to say what the tab already knows, and the sidebar would show
 * nothing new. Both show the row held here until the layout's list has it.
 *
 * In memory only, never localStorage: a session that exists is in the
 * database, and one whose creation didn't finish has nothing worth keeping.
 */
export type PendingSession = {
  workspace: Workspace;
  /** The server has made it: its row is the create call's answer, not the
   *  one the screen made up. */
  confirmed: boolean;
  /** The server refused to make it, and why: gone from the sidebar, and its
   *  page says so while it gives way to the new-session screen. */
  refused?: string;
};

export const PENDING_SESSIONS = store<Record<string, PendingSession>>({});

/** The same every time, so a hook over it doesn't re-render on every read. */
const NONE: Record<string, PendingSession> = {};

/**
 * The row the new-session screen holds for a session from the moment Send is
 * pressed, before the server has made it: what the page and the sidebar show
 * until the create call answers with the real one. Setting up, titled from
 * its prompt as the server will title it (lib/session/name-session.ts), on
 * the branch it is asked for, from the repository's default branch.
 */
export function optimisticSession(input: {
  id: string;
  project: Pick<Project, "id" | "defaultBranch">;
  prompt: string;
  /** The branch it is asked for. */
  branch: string;
  agent: AgentId;
  /** Who is starting it, as far as the screen knows; "" when it doesn't. */
  ownerId: string;
  /** Where the user's sessions run, as far as the screen knows. */
  provider: ProviderName;
  now?: Date;
}): Workspace {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: input.id,
    projectId: input.project.id,
    ownerId: input.ownerId,
    provider: input.provider,
    status: "creating",
    phase: null,
    branch: input.branch,
    // A prompt of only attachments names nothing: the sidebar still needs a label.
    title: sessionTitle(input.prompt) ?? "New session",
    baseBranch: input.project.defaultBranch,
    worktreePath: "",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: null,
    checkouts: null,
    agent: input.agent,
    model: null,
    mode: "build",
    lastActiveAt: at,
    errorMessage: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Keep `workspace`, so its page and the sidebar show it at once. */
export function rememberPendingSession(workspace: Workspace, confirmed = true): void {
  PENDING_SESSIONS.set({ ...PENDING_SESSIONS.get(), [workspace.id]: { workspace, confirmed } });
}

/** The server refused to make it: the sidebar drops it, and its page says
 *  why. Forgotten once the next session is started. */
export function refusePendingSession(id: string, why: string): void {
  const held = PENDING_SESSIONS.get()[id];
  if (held) PENDING_SESSIONS.set({ ...PENDING_SESSIONS.get(), [id]: { ...held, refused: why } });
}

/** Forget the ones the server refused: a new session is being started. */
export function forgetRefusedSessions(): void {
  const pending = PENDING_SESSIONS.get();
  const kept = Object.fromEntries(Object.entries(pending).filter(([, p]) => !p.refused));
  if (Object.keys(kept).length !== Object.keys(pending).length) PENDING_SESSIONS.set(kept);
}

/** Forget it: the sidebar's own data has it now. */
export function forgetPendingSession(id: string): void {
  const pending = PENDING_SESSIONS.get();
  if (!(id in pending)) return;
  const rest = { ...pending };
  delete rest[id];
  PENDING_SESSIONS.set(rest);
}

/** A session this tab started that the sidebar's data doesn't have yet; null
 *  for any other session, and once the sidebar does have it. */
export function usePendingSession(id: string | undefined): PendingSession | null {
  const pending = useStore(PENDING_SESSIONS, NONE);
  return (id && pending[id]) || null;
}

/** Every session this tab started that the sidebar's data may not have yet. */
export function usePendingSessions(): Record<string, PendingSession> {
  return useStore(PENDING_SESSIONS, NONE);
}

/**
 * A session whose creation the server refused after its page had opened:
 * what was asked, and why it couldn't be, for the new-session screen to say
 * and to give the prompt back.
 */
export type FailedCreate = {
  prompt: string;
  message: string;
  /** The way out, when one page holds it (as the screen's own errors). */
  action: { label: string; href: string; kind: "step" | "refusal" } | null;
};

export const FAILED_CREATE = store<FailedCreate | null>(null);

/** The last creation that failed, until the next is started. */
export function useFailedCreate(): FailedCreate | null {
  return useStore(FAILED_CREATE, null);
}
