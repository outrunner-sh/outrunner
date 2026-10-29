/** Native Codex /models metadata; no model names or entitlements inferred from
 * the generic OpenAI API. Unknown capability fields stay unknown. */
import { isEffort, validModelId, type SessionModel } from "@/lib/runtime/session-models";

export function codexCatalog(raw: unknown): SessionModel[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = (raw as { models?: unknown }).models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): SessionModel[] => {
    if (!row || typeof row !== "object") return [];
    const m = row as Record<string, unknown>;
    if (typeof m.slug !== "string" || !validModelId(m.slug) || m.visibility !== "list") return [];
    const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.flatMap((level) => {
      const effort = typeof level === "object" && level ? level.effort : undefined;
      return isEffort(effort) ? [effort] : [];
    }) : [];
    return [{ id: m.slug, label: typeof m.display_name === "string" ? m.display_name : m.slug,
      provider: "codex", efforts,
      ...(isEffort(m.default_reasoning_level) && efforts.includes(m.default_reasoning_level) ? { defaultEffort: m.default_reasoning_level } : {}),
      ...(Array.isArray(m.input_modalities) ? { supportsImages: m.input_modalities.includes("image") } : {}),
      isDefault: m.is_default === true,
    }];
  });
}
