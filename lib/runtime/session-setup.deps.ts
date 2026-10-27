/**
 * Real wiring for session-setup: reads the user's setup and the session's
 * project (lib/db/environments.ts), and mints the archive's download URL. Kept apart from
 * `session-setup.ts` so that stays free of the database and unit-testable.
 */

import { getAgentConfig } from "@/lib/db/agent-config";
import { getGithubIdentity } from "@/lib/db/credentials";
import { defaultEnvironmentId, environmentSetup, type EnvironmentSetup } from "@/lib/db/environments";
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
  /** The project the session started from; null for one from before
   *  projects, which gets its repository's default project. */
  environmentId: string | null,
): Promise<void> {
  const [environment, agentConfig, githubIdentity] = await Promise.all([
    sessionEnvironment(ownerId, projectId, environmentId),
    getAgentConfig(ownerId),
    getGithubIdentity(ownerId),
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
      appIdentity: githubIdentity === "app",
      downloadUrl: (path) => mintSnapshotDownloadUrl(supabaseSnapshotStorage(), path, ownerId),
    },
  );
}

/** The session's project's setup. Before the migration that adds projects,
 *  the repository's environment as it was kept (project_environment). */
async function sessionEnvironment(
  ownerId: string,
  projectId: string,
  environmentId: string | null,
): Promise<EnvironmentSetup | null> {
  const id = environmentId ?? (await defaultEnvironmentId(ownerId, projectId));
  if (id) return environmentSetup(ownerId, id);
  const kept = await getProjectEnvironment(ownerId, projectId);
  return kept && { ...kept, instructions: null };
}
