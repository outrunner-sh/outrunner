import { isAgentId } from "@/lib/agents/registry";
import type { RunnerStart } from "@/lib/missions/tools";
import type { Workspace } from "@/lib/runtime/types";
import type { SessionRequest } from "@/lib/session/create-cloud-session";
import { agentOf, agentsFor, modelChoice, CLAUDE_MODELS } from "@/lib/runtime/session-models";

/** The new-session request for a Ship under `runner`. */
export function runnerRequest(mission: Pick<Workspace, "model" | "agent">, start: RunnerStart): SessionRequest {
  const own = mission.model;
  let provider = own?.model.provider;
  let model: string | undefined = own?.model.id;
  if (start.model) {
    model = start.model;
    provider =
      start.agent === "codex"
        ? "codex"
        : CLAUDE_MODELS.some((m) => m.id === start.model)
          ? "claude"
          : own && own.model.provider !== "claude" && own.model.provider !== "codex"
            ? own.model.provider
            : "outrunner";
  }
  // A harness override without a model must not inherit the other harness's
  // model or effort. Let creation resolve that harness's eligible default.
  if (!start.model && start.agent && provider && (!isAgentId(start.agent) || !agentsFor(provider).includes(start.agent))) {
    model = undefined;
    provider = undefined;
  }
  const selected = modelChoice(provider, model);
  const agent = start.agent ?? (selected ? agentOf(selected.provider, mission.agent) : mission.agent);
  const inheritedEffort = model === own?.model.id && provider === own?.model.provider && agent === mission.agent ? own?.effort : null;
  const effort = start.effort ?? inheritedEffort;
  return {
    ...(model && { provider, model }),
    ...(effort && { effort }),
    ...(agent && { agent }),
    prompt: start.brief,
  };
}

