/**
 * Real wiring for a cloud session relaunching on the box it ran on (a resume,
 * an attach that starts it): signed in as the user picks now, and back on its
 * recorded model with its key fetched again. Kept apart from session-auth.ts
 * and model-switch.ts so those stay free of the database and unit-testable.
 */

import { agentAuthStore, modelKey } from "@/lib/db/credentials";
import type { AgentClient, WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { putBackOnModel } from "@/lib/runtime/model-switch";
import { relaunchNeedsAccount, sessionAuthClient, signInSession } from "@/lib/runtime/session-auth";
import type { Workspace } from "@/lib/runtime/types";
import type { SessionChat } from "@/lib/session/chats";
import { reconcileHarnessSelection } from "@/lib/session/harness-selection.deps";

/** Ready `workspace`'s session to relaunch: its failures are signInFailure's
 *  to tell the user. */
export async function readyRelaunch(
  agent: AgentClient,
  identity: WorkspaceIdentity,
  upgrade: (() => Promise<void>) | undefined,
  workspace: Pick<Workspace, "agent" | "model" | "orgId">,
  ownerId: string,
): Promise<void> {
  workspace = { ...workspace, ...await reconcileHarnessSelection(agent, identity, workspace) };
  await signInSession(
    sessionAuthClient(agent, identity, upgrade),
    workspace.agent,
    agentAuthStore(ownerId, workspace.orgId),
    relaunchNeedsAccount(workspace.agent, workspace.model),
  );
  await putBackOnModel(
    { setModel: (req) => agent.setModel(identity, { ...req,...(workspace.model && {selection:workspace.model}) }), keyFor: (holder) => modelKey(ownerId, holder, workspace.orgId) },
    workspace.model,
  );
}

/** Ready one of a session's chats other than its main one to launch, as
 *  readyRelaunch does the session: signed in on its own agent, and on its
 *  recorded model. */
export async function readyChatRelaunch(
  agent: AgentClient,
  identity: WorkspaceIdentity,
  upgrade: (() => Promise<void>) | undefined,
  workspace: Pick<Workspace, "orgId">,
  chat: Pick<SessionChat, "id" | "agent" | "model">,
  ownerId: string,
): Promise<void> {
  chat = { ...chat, ...await reconcileHarnessSelection(agent, identity, chat, chat.id) };
  await signInSession(
    sessionAuthClient(agent, identity, upgrade, chat.id),
    chat.agent,
    agentAuthStore(ownerId, workspace.orgId),
    relaunchNeedsAccount(chat.agent, chat.model),
  );
  await putBackOnModel(
    { setModel: (req) => agent.setModel(identity, { ...req,...(chat.model && {selection:chat.model}) }, chat.id), keyFor: (holder) => modelKey(ownerId, holder, workspace.orgId) },
    chat.model,
  );
}
