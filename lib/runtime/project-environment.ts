/**
 * Handing a cloud session its project's environment (lib/db/project-
 * environment.ts) before it launches: its variables, its checkout's .env
 * files and its setup script.
 * A box whose agent is too old for it is upgraded in place first; one that
 * can't be launches the session without it, rather than not at all.
 */

import { requireFeature, type FeatureClient } from "@/lib/runtime/box-features";
import { AGENT_FEATURE_ENVIRONMENT, type SetEnvironmentRequest } from "@/lib/runtime/agent-protocol";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import type { ProjectEnvironment } from "@/lib/db/project-environment";

export type EnvironmentClient = FeatureClient & {
  setEnvironment(req: SetEnvironmentRequest): Promise<unknown>;
};

/** Deliver `environment` (null: the project has none) to the session. */
export async function deliverProjectEnvironment(
  client: EnvironmentClient,
  environment: ProjectEnvironment | null,
): Promise<void> {
  if (!environment) return;
  const req: SetEnvironmentRequest = {
    env: environment.env,
    ...(Object.keys(environment.files).length > 0 && { files: environment.files }),
    ...(environment.setup && { setup: environment.setup }),
  };
  if (Object.keys(req.env).length === 0 && !req.files && !req.setup) return;
  try {
    await requireFeature(client, AGENT_FEATURE_ENVIRONMENT, "take a project's environment");
  } catch (error) {
    if (!(error instanceof OutdatedComputerError)) throw error;
    console.warn(`${error.message} The session starts without it.`);
    return;
  }
  await client.setEnvironment(req);
}
