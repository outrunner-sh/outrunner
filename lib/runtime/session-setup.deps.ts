/**
 * Real wiring for session-setup: reads the user's setup and the project's
 * environment, and mints the archive's download URL. Kept apart from
 * `session-setup.ts` so that stays free of the database and unit-testable.
 */

import { getAgentConfig } from "@/lib/db/agent-config";
import { getProjectEnvironment } from "@/lib/db/project-environment";
import type { AgentClient, WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { deliverSessionSetup } from "@/lib/runtime/session-setup";
import { mintSnapshotDownloadUrl } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";

/** Set the session up on its box before it launches. */
export async function setUpSession(
  agent: AgentClient,
  identity: WorkspaceIdentity,
  upgrade: (() => Promise<void>) | undefined,
  ownerId: string,
  projectId: string,
): Promise<void> {
  const [environment, agentConfig] = await Promise.all([
    getProjectEnvironment(ownerId, projectId),
    getAgentConfig(ownerId),
  ]);
  await deliverSessionSetup(
    {
      features: async () => (await agent.health(identity)).features ?? [],
      upgrade,
      setEnvironment: (req) => agent.setEnvironment(identity, req),
      setAgentConfig: (req) => agent.setAgentConfig(identity, req),
    },
    {
      environment,
      agentConfig,
      downloadUrl: (path) => mintSnapshotDownloadUrl(supabaseSnapshotStorage(), path, ownerId),
    },
  );
}
