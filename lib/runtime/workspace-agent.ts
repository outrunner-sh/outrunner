import { NextResponse } from "next/server";

import { getWorkspaceComputer, getWorkspace, readRuntimeComputerSecret } from "@/lib/db/repositories";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";

/** A cloud session's agent, reached: the client to call it with, and who asks. */
export type WorkspaceAgent = {
  workspace: Workspace;
  provider: ComputerRuntimeProvider;
  sandboxId: string;
  /** The box's agent secret, for a call that upgrades the agent in place. */
  secret: string;
  agent: AgentClient;
  identity: WorkspaceIdentity;
};

/** A cloud session's box, reached: no further than the provider knows it,
 *  the agent on it not asked. */
export type WorkspaceComputer = {
  workspace: Workspace;
  provider: ComputerRuntimeProvider;
  computerId: string;
  sandboxId: string;
};

type Fail = { ok: false; response: NextResponse };
const fail = (error: string, status: number): Fail => ({ ok: false, response: NextResponse.json({ error }, { status }) });

/**
 * The box a cloud session runs on, or the response saying why there isn't
 * one to use: no such workspace, one `admit` turns away (checked first,
 * before anything else is read), a provider without boxes (`needsComputer`
 * says what needs one), or a box not ready. For what is done to the box
 * itself (its desktop), which the agent on it has no part in: a wedged
 * agent doesn't stand in its way.
 */
export async function reachWorkspaceComputer(
  workspaceId: string,
  { needsComputer, admit }: { needsComputer: string; admit?: (workspace: Workspace) => NextResponse | null },
): Promise<{ ok: true; reached: WorkspaceComputer } | Fail> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return fail("Workspace not found.", 404);
  const refused = admit?.(workspace);
  if (refused) return { ok: false, response: refused };

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return { ok: false, response: providerErrorResponse(resolution) };
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) return fail(needsComputer, 409);

  const computer = await getWorkspaceComputer(workspace);
  if (!computer || !computer.daytonaSandboxId || computer.status !== "ready") {
    return fail("Runtime Computer is not ready.", 409);
  }
  return { ok: true, reached: { workspace, provider, computerId: computer.id, sandboxId: computer.daytonaSandboxId } };
}

/**
 * The agent on the box a cloud session runs on, for `userId`, or the response
 * saying why it can't be reached: no such workspace, a provider without boxes
 * (`needsComputer` says what needs one), a box not ready, or not answering.
 * `label` names the route in the log.
 */
export async function reachWorkspaceAgent(
  workspaceId: string,
  userId: string,
  { label, needsComputer }: { label: string; needsComputer: string },
): Promise<{ ok: true; reached: WorkspaceAgent } | Fail> {
  const box = await reachWorkspaceComputer(workspaceId, { needsComputer });
  if (!box.ok) return box;
  const { workspace, provider, computerId, sandboxId } = box.reached;
  const secret = await readRuntimeComputerSecret(computerId);
  if (!secret) return fail("Runtime Computer secret missing.", 500);

  let target;
  try {
    target = await provider.agentTarget(sandboxId, secret);
  } catch (error) {
    console.error(`${label}: agentTarget failed for ${workspace.id}`, error);
    return fail("Could not reach the Runtime Computer.", 503);
  }
  return {
    ok: true,
    reached: {
      workspace,
      provider,
      sandboxId,
      secret,
      agent: new AgentClient(target),
      identity: { workspaceId: workspace.id, projectId: workspace.projectId, computerId, userId },
    },
  };
}
