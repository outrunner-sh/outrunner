import type { AgentId } from "@/lib/agents/registry";
import type { ModelLoadout } from "@/lib/runtime/model-loadout";
import { creationSelection } from "@/lib/runtime/selection";
import type { ModelGroup, RecordedModel } from "@/lib/runtime/session-models";

/** Same-harness forks retain the source's explicit selection. Another harness
 * resolves its own eligible defaults; it never inherits the source's effort. */
export function chatSelection(source: { agent: AgentId; model: RecordedModel | null }, target: AgentId,
  groups: ModelGroup[], loadout: ModelLoadout): RecordedModel | null {
  if (source.agent === target) return source.model;
  const selected = creationSelection(groups, loadout, { agent: target, defaultEffort: true });
  return { model: selected.model, effort: selected.effort };
}
