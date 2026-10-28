/**
 * A session's box, reached by the server with no user signed in (as the
 * reconciler does, lib/billing/reconcile-run.ts): for what the Missions code
 * reads of a Runner or a Mission (whether it's mid-turn, its latest reply)
 * many times a tick, where signing in as the owner each time
 * (lib/supabase/acting-user.ts) would cost a sign-in per read. Anything that
 * changes a session still goes through its routes, as its owner.
 */

import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import type { WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type Reached = { agent: AgentClient; identity: WorkspaceIdentity };

/** The session's agent, or null when its box isn't up (asleep, archived,
 *  setting up) or can't be reached. */
export async function reachBox(workspace: Workspace): Promise<Reached | null> {
  if (workspace.status !== "ready" && workspace.status !== "idle") return null;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
  const filter = workspace.computerId
    ? `workspace_id.eq.${workspace.id},id.eq.${workspace.computerId}`
    : `workspace_id.eq.${workspace.id}`;
  const { data, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("id, workspace_id, status, daytona_sandbox_id, agent_secret")
    .or(filter);
  if (error) throw error;
  const computer = (data ?? []).find((c) => c.workspace_id === workspace.id) ?? data?.[0];
  if (!computer || computer.status !== "ready" || !computer.daytona_sandbox_id || !computer.agent_secret) return null;
  try {
    const target = await resolution.provider.agentTarget(computer.daytona_sandbox_id, computer.agent_secret);
    return {
      agent: new AgentClient(target),
      identity: { workspaceId: workspace.id, projectId: workspace.projectId, computerId: computer.id, userId: workspace.ownerId },
    };
  } catch (error) {
    console.warn(`Missions: couldn't reach ${workspace.id}'s box`, error);
    return null;
  }
}

/** The session's summary (its latest reply, its last activity), or null. */
export async function boxSummary(workspace: Workspace): Promise<WorkspaceSummary | null> {
  const reached = await reachBox(workspace).catch(() => null);
  if (!reached) return null;
  return reached.agent.workspaceSummary(reached.identity).catch(() => null);
}

/** Whether the session's agent is mid-turn. Its box is its own
 *  (lib/runtime/computer-scope.ts), so the box's activity is the session's. */
export async function boxWorking(workspace: Workspace): Promise<boolean> {
  const reached = await reachBox(workspace).catch(() => null);
  if (!reached) return false;
  const { workspaceId: _, ...box } = reached.identity;
  void _;
  const activity = await reached.agent.activity(box).catch(() => null);
  return activity?.turnInProgress ?? false;
}

/** Write a file into the session's worktree, if its box is up; false when
 *  it isn't (its next setup lays it out instead). */
export async function writeBoxFile(
  workspace: Workspace,
  relPath: string,
  content: string,
  options: { ifMissing?: boolean } = {},
): Promise<boolean> {
  if ((workspace.status !== "ready" && workspace.status !== "idle") || !workspace.worktreePath) return false;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return false;
  const { data } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("workspace_id, status, daytona_sandbox_id")
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!data?.daytona_sandbox_id || data.status !== "ready") return false;
  return resolution.provider.writeWorkspaceFile(data.daytona_sandbox_id, workspace.worktreePath, relPath, Buffer.from(content), options);
}
