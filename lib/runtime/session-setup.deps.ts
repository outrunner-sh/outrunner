/**
 * Real wiring for session-setup: reads the user's setup and the session's
 * project (lib/db/environments.ts) and its skills, and mints the archive's
 * download URL and its private registries' tokens. Kept apart from
 * `session-setup.ts` so that stays free of the database and unit-testable.
 */

import { getAgentConfig } from "@/lib/db/agent-config";
import { getGithubIdentity } from "@/lib/db/credentials";
import { defaultEnvironmentId, environmentSetup, type EnvironmentSetup } from "@/lib/db/environments";
import { listEnvironmentSkills } from "@/lib/db/environment-skills";
import { getProjectEnvironment } from "@/lib/db/project-environment";
import { skillSources } from "@/lib/environments/skills";
import { repositorySource } from "@/lib/github/repository-source";
import { withMissionEnvironment, withMissionServer } from "@/lib/missions/setup";
import { missionBoxSetup } from "@/lib/missions/setup.deps";
import type { AgentClient, WorkspaceIdentity } from "@/lib/runtime/agent-client";
import type { SkillSource } from "@/lib/runtime/agent-protocol";
import { deliverSessionSetup } from "@/lib/runtime/session-setup";
import { mintSnapshotDownloadUrl } from "@/lib/runtime/storage";
import { syncEnvironmentSecrets } from "@/lib/secret-sync/sync.deps";
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
  /** `appIdentity`: it works as the Outrunner App whatever its user chose
   *  (an automation's review). */
  override?: { appIdentity?: boolean },
): Promise<void> {
  const id = environmentId ?? (await defaultEnvironmentId(ownerId, projectId));
  const [environment, skills, agentConfig, githubIdentity, mission] = await Promise.all([
    sessionEnvironment(ownerId, projectId, id),
    id ? sessionSkills(ownerId, id) : undefined,
    getAgentConfig(ownerId),
    getGithubIdentity(ownerId),
    // A Mission's box also gets its tools, notes and instructions.
    missionBoxSetup(identity.workspaceId),
  ]);
  await deliverSessionSetup(
    {
      features: async () => (await agent.health(identity)).features ?? [],
      upgrade,
      setEnvironment: (req) => agent.setEnvironment(identity, req),
      setAgentConfig: (req) => agent.setAgentConfig(identity, req),
      setSkills: (req) => agent.setSkills(identity, req),
    },
    {
      environment: mission ? withMissionEnvironment(environment, mission) : environment,
      agentConfig: mission ? withMissionServer(agentConfig, mission) : agentConfig,
      skills,
      appIdentity: override?.appIdentity || githubIdentity === "app",
      downloadUrl: (path) => mintSnapshotDownloadUrl(supabaseSnapshotStorage(), path, ownerId),
    },
  );
}

/** The session's project's setup, with the secrets of the Doppler or
 *  Infisical config it's linked to fetched now (docs/secret-sync.md): a
 *  provider that fails leaves them out and says so on the project's page,
 *  and the session starts all the same. Before the migration that adds
 *  projects, the repository's environment as it was kept
 *  (project_environment). */
async function sessionEnvironment(
  ownerId: string,
  projectId: string,
  id: string | null,
): Promise<EnvironmentSetup | null> {
  if (id) {
    const setup = await environmentSetup(ownerId, id);
    if (!setup) return null;
    const synced = await syncEnvironmentSecrets(id, { env: setup.env, startHook: setup.hooks?.start ?? null });
    return { ...setup, env: synced.env, hooks: { warm: setup.hooks?.warm ?? null, start: synced.startHook } };
  }
  const kept = await getProjectEnvironment(ownerId, projectId);
  return kept && { ...kept, instructions: null };
}

/**
 * The repositories the project's skills install from, a private registry's
 * with a token that reads it alone: the org's GitHub App's where it has one,
 * else the session's user's own sign-in, as its repositories are listed
 * (lib/github/repository-source.ts). A registry no token reaches is still
 * sent, without one: the box says it couldn't read it, and the session
 * starts with the rest. Skills unread start the session without any.
 */
async function sessionSkills(ownerId: string, environmentId: string): Promise<SkillSource[] | undefined> {
  try {
    const listed = await listEnvironmentSkills(ownerId, environmentId);
    if (!listed || (listed.skills.length === 0 && listed.registries.length === 0)) return undefined;
    const privateOnes = listed.registries.filter((r) => r.private);
    const source = privateOnes.length > 0 ? await repositorySource(ownerId, listed.orgId).catch(noToken) : null;
    const registries = await Promise.all(
      listed.registries.map(async (r) => ({
        fullName: r.fullName,
        branch: r.defaultBranch,
        token: (r.private && (await source?.readToken(r.fullName).catch(noToken))) || undefined,
      })),
    );
    return skillSources(listed.skills, registries);
  } catch (error) {
    console.warn(`Project ${environmentId}'s skills couldn't be read; the session starts without them.`, error);
    return undefined;
  }
}

function noToken(error: unknown): null {
  console.warn("No GitHub token for a project's skill registry", error instanceof Error ? error.message : error);
  return null;
}
