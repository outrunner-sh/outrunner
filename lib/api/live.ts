/**
 * Reading a session's conversation for the public API: from its box while
 * the box is up (never woken for a read), else from its latest snapshot.
 * Inside apiRoute, as the session's owner: RLS keeps it theirs.
 */

import {
  conversationFrom,
  entriesFromEvents,
  readUntilQuiet,
  type ConversationEntry,
} from "@/lib/api/conversation";
import {
  getWorkspaceComputer,
  listWorkspaceSnapshots,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { AgentClient } from "@/lib/runtime/agent-client";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { assembleConversation, fetchSnapshotBytes } from "@/lib/runtime/replay/load";
import { resolveProvider } from "@/lib/runtime/resolve";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { Workspace } from "@/lib/runtime/types";

/** As AgentClient's calls to the box. */
const CONNECT_TIMEOUT_MS = 12_000;

export type Conversation = {
  entries: ConversationEntry[];
  /** The session's state on its box (running, exited), when read live. */
  state: string | null;
  /** Where it was read: the box, the latest snapshot, or neither. */
  from: "live" | "archive" | "none";
};

/** The box's event stream URL, while its box is up; null when it isn't. */
async function liveEventsUrl(workspace: Workspace, chat?: string): Promise<string | null> {
  if (workspace.status !== "ready" && workspace.status !== "idle") return null;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
  const provider = resolution.provider;
  const computer = await getWorkspaceComputer(workspace);
  const sandboxId = computer?.daytonaSandboxId;
  if (!computer || !sandboxId || computer.status !== "ready") return null;
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) return null;
  const agent = new AgentClient(await provider.agentTarget(sandboxId, secret));
  return agent.eventsSseUrl({
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: workspace.ownerId,
  }, chat);
}

/** The session's conversation as its box has it now (its main chat's, or
 *  `chat`'s), or null when its box is down or doesn't answer. */
export async function readLiveConversation(workspace: Workspace, chat?: string): Promise<Conversation | null> {
  const url = await liveEventsUrl(workspace, chat).catch((error: unknown) => {
    console.warn(`API: couldn't find ${workspace.id}'s box`, error);
    return null;
  });
  if (!url) return null;
  const connect = new AbortController();
  const timeout = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
  const upstream = await fetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal: connect.signal })
    .catch((error: unknown) => {
      console.warn(`API: couldn't reach ${workspace.id}'s box`, error);
      return null;
    })
    .finally(() => clearTimeout(timeout));
  if (!upstream?.ok || !upstream.body) {
    await upstream?.body?.cancel().catch(() => undefined);
    return null;
  }
  const { entries, state } = conversationFrom(await readUntilQuiet(upstream.body));
  return { entries, state, from: "live" };
}

/** The session's conversation: live where its box is up, else its latest
 *  snapshot's, else none. A chat other than the main one (`chat`) is read
 *  live only: a snapshot holds the main chat's. */
export async function readConversation(workspace: Workspace, chat?: string): Promise<Conversation> {
  const live = await readLiveConversation(workspace, chat);
  if (live) return live;
  if (chat) return { entries: [], state: null, from: "none" };
  const snapshot = (await listWorkspaceSnapshots(workspace.id))[0];
  if (!snapshot) return { entries: [], state: null, from: "none" };
  const events = await assembleConversation({
    snapshot,
    ownerId: workspace.ownerId,
    storage: supabaseSnapshotStorage(),
    fetchBytes: fetchSnapshotBytes,
  });
  return { ...entriesFromEvents(events), from: "archive" };
}
