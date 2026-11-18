/**
 * GET /models, the part with no network: the menu (lib/runtime/session-models.ts
 * modelGroups) as the API answers it, with the efforts each model takes and
 * the one a session starts on when a call names none (lib/runtime/selection.ts
 * initialSelection, as POST /workspaces picks). lib/api/models.deps.ts reads
 * the caller's menu.
 */

import { cursorModelItems } from "@/lib/api/cursor";
import type { ModelLoadout } from "@/lib/runtime/model-loadout";
import { initialSelection } from "@/lib/runtime/selection";
import { agentsFor, effortsFor, type ModelGroup } from "@/lib/runtime/session-models";

/** The menu as the API answers it: one item per model, in the menu's order. */
export function modelsJson(groups: ModelGroup[], loadout: ModelLoadout): Record<string, unknown> {
  const fallback = initialSelection(groups, loadout);
  const data = groups.flatMap((group) =>
    group.models.map((model) => {
      const isDefault = !!fallback && fallback.model.provider === model.provider && fallback.model.id === model.id;
      return {
        id: model.id,
        provider: model.provider,
        label: model.label,
        group: group.label,
        agents: agentsFor(model.provider),
        efforts: effortsFor(model),
        default_effort: isDefault ? fallback.effort : (model.defaultEffort ?? null),
        supports_images: model.supportsImages ?? null,
        default: isDefault,
      };
    }),
  );
  // A group that takes an id typed in (a provider on the user's own key)
  // runs more than its list: said, so a caller knows to try theirs.
  const custom = groups.filter((g) => g.custom).map((g) => g.provider);
  // `items` as Cursor's GET /v1/models lists them, for scripts moved from it.
  return { data, custom_providers: custom, items: cursorModelItems(data) };
}
