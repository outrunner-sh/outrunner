/**
 * Setting a cloud session up before it launches: an agent that can ask for
 * GitHub tokens, for a user who works as the Outrunner App
 * (lib/github/identity.ts); the user's own agent setup on its computer
 * (lib/db/agent-config.ts) and its project's environment
 * (lib/db/environments.ts): variables, files, setup script, instructions, and
 * its skills (lib/db/environment-skills.ts). A box whose agent is too old for either is
 * upgraded in place first; one that can't be launches the session without
 * it, rather than not at all.
 */

import type { AgentConfig } from "@/lib/db/agent-config";
import type { EnvironmentSetup } from "@/lib/db/environments";
import {
  AGENT_FEATURE_AGENT_CONFIG,
  AGENT_FEATURE_AGENT_CONTEXT,
  AGENT_FEATURE_CODEX_MCP,
  AGENT_FEATURE_CODEX_SECRETS,
  AGENT_FEATURE_ENVIRONMENT,
  AGENT_FEATURE_GIT_CREDENTIAL,
  AGENT_FEATURE_INSTRUCTIONS,
  AGENT_FEATURE_SKILLS,
  AGENT_FEATURE_WARM_HOOKS,
  type AgentName,
  type SetAgentConfigRequest,
  type SetAgentContextRequest,
  type SetEnvironmentRequest,
  type SetSkillsRequest,
  type SetSkillsResponse,
  type SkillSource,
} from "@/lib/runtime/agent-protocol";
import { cachedFeatures, requireFeature, type FeatureClient } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";

export type SetupClient = FeatureClient & {
  setEnvironment(req: SetEnvironmentRequest): Promise<unknown>;
  setAgentConfig(req: SetAgentConfigRequest): Promise<unknown>;
  setAgentContext(req: SetAgentContextRequest): Promise<unknown>;
  setSkills(req: SetSkillsRequest): Promise<SetSkillsResponse>;
};

export type SessionSetup = {
  environment: EnvironmentSetup | null;
  agentConfig: AgentConfig | null;
  /** The repositories its project's skills install from
   *  (lib/environments/skills.ts skillSources); none for a project with no
   *  skills. */
  skills?: SkillSource[];
  /** What every session reads besides its orientation; undefined leaves the
   *  current block untouched and empty clears one left by an earlier setup. */
  agentContext?: string;
  /** Its user works on GitHub as the Outrunner App, whose tokens the box
   *  must ask for as it goes (lib/github/identity.ts). */
  appIdentity?: boolean;
  /** The coding agent the session runs; Claude where not said. */
  agent?: AgentName;
  /** A signed download URL for the setup's archive. */
  downloadUrl(path: string): Promise<string>;
};

/** Deliver the session's setup; what the box can't take is skipped, said. */
export async function deliverSessionSetup(client: SetupClient, setup: SessionSetup): Promise<void> {
  const capabilities = cachedFeatures(client);
  // First: an upgrade boots the agent again, asking with what it needs to.
  if (setup.appIdentity) await supports(capabilities, AGENT_FEATURE_GIT_CREDENTIAL, "work on GitHub as Outrunner's GitHub App");

  if (setup.agent === "codex") {
    await supports(capabilities, AGENT_FEATURE_CODEX_SECRETS, "let Codex request secrets through a form");
  }

  const config = setup.agentConfig;
  if (config && (config.archive || Object.keys(config.mcpServers).length > 0 || Object.keys(config.settings).length > 0)) {
    // A Codex session's box must give Codex the servers too: upgraded to an
    // agent that does where it can be. A Claude session's has always given
    // them to Claude, so its agent isn't rebooted for it.
    if (setup.agent === "codex" && Object.keys(config.mcpServers).length > 0) {
      await supports(capabilities, AGENT_FEATURE_CODEX_MCP, "give Codex your MCP servers");
    }
    if (await supports(capabilities, AGENT_FEATURE_AGENT_CONFIG, "take your agent setup")) {
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

  // Before the environment, whose launch is next: the skills are on the box
  // when the agent starts and lists them. A repository the box couldn't
  // read is said in the log and the session starts without its skills,
  // rather than not at all.
  if (setup.skills?.length && (await supports(capabilities, AGENT_FEATURE_SKILLS, "install a project's skills"))) {
    try {
      const result = await client.setSkills({ sources: setup.skills });
      for (const failure of result.failed ?? []) {
        console.warn(`A project skill wasn't installed (${failure.repo}${failure.skill ? ` ${failure.skill}` : ""}): ${failure.error}`);
      }
    } catch (error) {
      console.warn("The project's skills couldn't be installed; the session starts without them.", error);
    }
  }

  if (setup.agentContext !== undefined) {
    const content = setup.agentContext;
    const takes = content
      ? await supports(capabilities, AGENT_FEATURE_AGENT_CONTEXT, "load your learnings")
      : (await capabilities.features()).includes(AGENT_FEATURE_AGENT_CONTEXT);
    // Never what keeps a session from starting: it launches with what the
    // box had.
    if (takes) {
      await client.setAgentContext({ content }).catch((error: unknown) => {
        console.error("The box didn't take the session's learnings; it starts without them", error);
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
  // Only to an agent that reads them: an older one would take the rest and
  // drop them without a word.
  if (environment.instructions && (await supports(capabilities, AGENT_FEATURE_INSTRUCTIONS, "take a project's instructions"))) {
    req.instructions = environment.instructions;
  }
  const hooks = environment.hooks;
  if ((hooks?.warm || hooks?.start) && (await supports(capabilities, AGENT_FEATURE_WARM_HOOKS, "run a project's warm and start hooks"))) {
    if (hooks.warm) req.warmHook = hooks.warm;
    if (hooks.start) req.startHook = hooks.start;
  }
  if (Object.keys(req.env).length === 0 && !req.files && !req.setup && !req.instructions && !req.warmHook && !req.startHook) {
    return;
  }
  if (await supports(capabilities, AGENT_FEATURE_ENVIRONMENT, "take a project's environment")) {
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
