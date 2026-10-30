import type { AgentId } from "@/lib/agents/registry";
import type { ModelLoadout } from "@/lib/runtime/model-loadout";
import { creationSelection } from "@/lib/runtime/selection";
import type { ModelGroup, RecordedModel } from "@/lib/runtime/session-models";

/** A fresh chat follows the active chat's saved setup. If the user explicitly
 * chooses another harness, reuse that harness's most recently created saved
 * setup in this session. `undefined` asks the caller to resolve its defaults. */
export function rememberedChatSelection(
  active: { agent: AgentId; model: RecordedModel | null },
  target: AgentId,
  chats: readonly { agent: AgentId; model: RecordedModel | null }[],
): RecordedModel | undefined {
  if (active.agent === target && active.model) return active.model;
  for (let i = chats.length - 1; i >= 0; i--) {
    const chat = chats[i];
    if (chat.agent === target && chat.model) return chat.model;
  }
  return undefined;
}

/** Resolve a harness's configured eligible default for a chat with no saved
 * setup of its own yet. */
export function configuredChatSelection(target: AgentId, groups: ModelGroup[], loadout: ModelLoadout): RecordedModel {
  const selected = creationSelection(groups, loadout, { agent: target, defaultEffort: true });
  return { model: selected.model, effort: selected.effort };
}

/** Same-harness forks retain the source's explicit selection. Another harness
 * resolves its own eligible defaults; it never inherits the source's effort. */
export function chatSelection(source: { agent: AgentId; model: RecordedModel | null }, target: AgentId,
  groups: ModelGroup[], loadout: ModelLoadout): RecordedModel | null {
  if (source.agent === target) return source.model;
  return configuredChatSelection(target, groups, loadout);
}
