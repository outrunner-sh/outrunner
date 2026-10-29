/** Selection rules shared by composers and creation routes. Preferences are read,
 * never rewritten when credentials or target eligibility changes. */
import { AGENT_IDS, type AgentId } from "@/lib/agents/registry";
import { effortOnPick, loadoutDefault, offeredModel, type ModelLoadout } from "@/lib/runtime/model-loadout";
import { agentOf, agentsFor, compatibleEffort, type Effort, type ModelGroup, type SessionModel } from "@/lib/runtime/session-models";

export function eligibleHarnesses(groups: ModelGroup[], supported: readonly AgentId[] = AGENT_IDS): AgentId[] {
  return AGENT_IDS.filter((agent) => supported.includes(agent) && groups.some((g) => g.models.length > 0 && agentsFor(g.provider).includes(agent)));
}
export function groupsForHarness(groups: ModelGroup[], agent: AgentId): ModelGroup[] {
  return groups.filter((g) => agentsFor(g.provider).includes(agent));
}
export function initialSelection(groups: ModelGroup[], loadout: ModelLoadout, agent?: AgentId, supported?: readonly AgentId[]) {
  if (agent && supported && !supported.includes(agent)) return null;
  const eligible = (agent ? groupsForHarness(groups, agent) : groups).filter((g) => !supported || agentsFor(g.provider).some((a) => supported.includes(a)));
  const saved = loadoutDefault(loadout, eligible);
  // With no preference use the runtime catalog's default, then the first
  // eligible model. No implicit Claude account override.
  const model = saved ?? eligible.flatMap((g) => g.models).find((m) => m.isDefault) ?? eligible[0]?.models[0];
  const preferred = agent ?? (saved ? loadout.default?.agent : undefined);
  const harness = preferred && (!supported || supported.includes(preferred)) ? preferred
    : model ? agentsFor(model.provider).find((a) => !supported || supported.includes(a)) : undefined;
  return model && harness ? { model, agent: agentOf(model.provider, harness), effort: effortOnPick(loadout, model) } : null;
}
export function selectionForHarness(groups: ModelGroup[], loadout: ModelLoadout, agent: AgentId,
  remembered?: { model: SessionModel; effort: Effort | null }) {
  const offered = remembered && offeredModel(groupsForHarness(groups, agent), remembered.model);
  return offered ? { model: offered, agent, effort: compatibleEffort(offered, remembered.effort) } : initialSelection(groups, loadout, agent);
}

/** The server uses the same eligible choice as the form. Explicit choices fail
 * closed; defaults may fall back without changing the saved preference. */
export function creationSelection(groups: ModelGroup[], loadout: ModelLoadout, requested: {
  model?: SessionModel; agent?: AgentId; effort?: Effort | null; defaultEffort?: boolean; supported?: readonly AgentId[];
}) {
  const fallback = initialSelection(groups, loadout, requested.agent, requested.supported);
  const model = requested.model ? offeredModel(groups, requested.model) : fallback?.model;
  if (!model) throw new Error("The selected model isn't available for this environment and connected account. Check Coding agents or refresh models.");
  const agent = requested.agent ?? (requested.model ? agentOf(model.provider) : fallback!.agent);
  if ((requested.supported && !requested.supported.includes(agent)) || !agentsFor(model.provider).includes(agent)) throw new Error("Choose a model the selected harness runs.");
  const effort = requested.defaultEffort && !requested.model ? fallback?.effort ?? null : requested.effort ?? null;
  if (effort && compatibleEffort(model, effort) !== effort) throw new Error("That effort isn't supported by the selected model. Choose an offered effort.");
  return { model, agent, effort };
}
