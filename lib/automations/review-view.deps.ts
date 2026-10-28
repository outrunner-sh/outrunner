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
import { assembleReplay } from "@/lib/runtime/replay/load";
import { resolveProvider } from "@/lib/runtime/resolve";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import { actAsUser } from "@/lib/supabase/acting-user";

export const reviewViewDeps: ReviewViewDeps = {
  connectorRunSession,
  asConnector: actAsUser,
  async liveEventsUrl(workspaceId, lastEventId) {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace || workspace.status === "destroyed") return null;
    const resolution = resolveProvider(workspace);
    if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
    const provider = resolution.provider;
    const computer = await getWorkspaceComputer(workspace);
    if (!computer?.daytonaSandboxId || computer.status !== "ready") return null;
    // Only a box that's up: reading never starts one.
    if (!(await provider.computerAlive(computer.daytonaSandboxId))) return null;
    const secret = await readRuntimeComputerSecret(computer.id);
    if (!secret) return null;
    const agent = new AgentClient(await provider.agentTarget(computer.daytonaSandboxId, secret));
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
    const payload = await assembleReplay({
      snapshot,
      ownerId: connectorId,
      storage: supabaseSnapshotStorage(),
      fetchBytes: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`fetch artifact failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    return { events: payload.events, archivedAt: snapshot.archivedAt };
  },
};
