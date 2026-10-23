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
  agent: AgentClient;
  identity: WorkspaceIdentity;
};

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
): Promise<{ ok: true; reached: WorkspaceAgent } | { ok: false; response: NextResponse }> {
  const fail = (error: string, status: number) => ({ ok: false as const, response: NextResponse.json({ error }, { status }) });
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return fail("Workspace not found.", 404);

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return { ok: false, response: providerErrorResponse(resolution) };
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) return fail(needsComputer, 409);

  const computer = await getWorkspaceComputer(workspace);
  if (!computer || !computer.daytonaSandboxId || computer.status !== "ready") {
    return fail("Runtime Computer is not ready.", 409);
  }
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) return fail("Runtime Computer secret missing.", 500);

  let target;
  try {
    target = await provider.agentTarget(computer.daytonaSandboxId, secret);
  } catch (error) {
    console.error(`${label}: agentTarget failed for ${workspace.id}`, error);
    return fail("Could not reach the Runtime Computer.", 503);
  }
  return {
    ok: true,
    reached: {
      workspace,
      provider,
      sandboxId: computer.daytonaSandboxId,
      agent: new AgentClient(target),
      identity: { workspaceId: workspace.id, projectId: workspace.projectId, computerId: computer.id, userId },
    },
  };
}
