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

/** Ready `workspace`'s session to relaunch: its failures are signInFailure's
 *  to tell the user. */
export async function readyRelaunch(
  agent: AgentClient,
  identity: WorkspaceIdentity,
  upgrade: (() => Promise<void>) | undefined,
  workspace: Pick<Workspace, "agent" | "model" | "orgId">,
  ownerId: string,
): Promise<void> {
  await signInSession(
    sessionAuthClient(agent, identity, upgrade),
    workspace.agent,
    agentAuthStore(ownerId, workspace.orgId),
    relaunchNeedsAccount(workspace.agent, workspace.model),
  );
  await putBackOnModel(
    { setModel: (req) => agent.setModel(identity, req), keyFor: (holder) => modelKey(ownerId, holder, workspace.orgId) },
    workspace.model,
  );
}
