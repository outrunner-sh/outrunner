/** The real reads behind lib/automations/review-view.ts. */

import type { ReviewViewDeps } from "@/lib/automations/review-view";
import { connectorRunSession } from "@/lib/db/automation-runs";
import {
  getWorkspace,
  getWorkspaceComputer,
  listWorkspaceSnapshots,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { AgentClient } from "@/lib/runtime/agent-client";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { assembleConversation, fetchSnapshotBytes } from "@/lib/runtime/replay/load";
import { resolveProvider } from "@/lib/runtime/resolve";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import { actAsUser } from "@/lib/supabase/acting-user";

export const reviewViewDeps: ReviewViewDeps = {
  connectorRunSession,
  asConnector: actAsUser,
  async boxUp(workspaceId) {
    return (await upBox(workspaceId)) !== null;
  },
  async liveEventsUrl(workspaceId, lastEventId) {
    const box = await upBox(workspaceId);
    if (!box) return null;
    const { workspace, computer, provider, sandboxId } = box;
    const secret = await readRuntimeComputerSecret(computer.id);
    if (!secret) return null;
    const agent = new AgentClient(await provider.agentTarget(sandboxId, secret));
    const url = new URL(
      agent.eventsSseUrl({
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        computerId: computer.id,
        userId: workspace.ownerId,
      }),
    );
    if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
    return url.toString();
  },
  async latestArchive(workspaceId, connectorId) {
    const snapshot = (await listWorkspaceSnapshots(workspaceId))[0];
    if (!snapshot) return null;
    const events = await assembleConversation({
      snapshot,
      ownerId: connectorId,
      storage: supabaseSnapshotStorage(),
      fetchBytes: fetchSnapshotBytes,
    });
    return { events, archivedAt: snapshot.archivedAt };
  },
};

/** The session's box, when it's up: reading never starts one. */
async function upBox(workspaceId: string) {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.status === "destroyed") return null;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
  const provider = resolution.provider;
  const computer = await getWorkspaceComputer(workspace);
  const sandboxId = computer?.daytonaSandboxId;
  if (!computer || !sandboxId || computer.status !== "ready") return null;
  if (!(await provider.computerAlive(sandboxId))) return null;
  return { workspace, computer, provider, sandboxId };
}
