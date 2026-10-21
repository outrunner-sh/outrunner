/**
 * Setting a cloud session up before it launches: the user's own agent setup
 * on its computer (lib/db/agent-config.ts) and its project's environment
 * (lib/db/project-environment.ts). A box whose agent is too old for either is
 * upgraded in place first; one that can't be launches the session without
 * it, rather than not at all.
 */

import type { AgentConfig } from "@/lib/db/agent-config";
import type { ProjectEnvironment } from "@/lib/db/project-environment";
import {
  AGENT_FEATURE_AGENT_CONFIG,
  AGENT_FEATURE_ENVIRONMENT,
  type SetAgentConfigRequest,
  type SetEnvironmentRequest,
} from "@/lib/runtime/agent-protocol";
import { requireFeature, type FeatureClient } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";

export type SetupClient = FeatureClient & {
  setEnvironment(req: SetEnvironmentRequest): Promise<unknown>;
  setAgentConfig(req: SetAgentConfigRequest): Promise<unknown>;
};

export type SessionSetup = {
  environment: ProjectEnvironment | null;
  agentConfig: AgentConfig | null;
  /** A signed download URL for the setup's archive. */
  downloadUrl(path: string): Promise<string>;
};

/** Deliver the session's setup; what the box can't take is skipped, said. */
export async function deliverSessionSetup(client: SetupClient, setup: SessionSetup): Promise<void> {
  const config = setup.agentConfig;
  if (config && (config.archive || Object.keys(config.mcpServers).length > 0 || Object.keys(config.settings).length > 0)) {
    if (await supports(client, AGENT_FEATURE_AGENT_CONFIG, "take your agent setup")) {
      await client.setAgentConfig({
        ...(config.archive && {
          version: config.archive.sha256,
          url: await setup.downloadUrl(config.archive.path),
          sha256: config.archive.sha256,
        }),
        mcpServers: config.mcpServers,
        settings: config.settings,
      });
    }
  }

  const environment = setup.environment;
  if (!environment) return;
  const req: SetEnvironmentRequest = {
    env: environment.env,
    ...(Object.keys(environment.files).length > 0 && { files: environment.files }),
    ...(environment.setup && { setup: environment.setup }),
  };
  if (Object.keys(req.env).length === 0 && !req.files && !req.setup) return;
  if (await supports(client, AGENT_FEATURE_ENVIRONMENT, "take a project's environment")) {
    await client.setEnvironment(req);
  }
}

/** Whether the box can `what` (upgraded first where it can be). */
async function supports(client: FeatureClient, feature: string, what: string): Promise<boolean> {
  try {
    await requireFeature(client, feature, what);
    return true;
  } catch (error) {
    if (!(error instanceof OutdatedComputerError)) throw error;
    console.warn(`${error.message} The session starts without it.`);
    return false;
  }
}
