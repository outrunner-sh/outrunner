/**
 * The public API's automations, the part with no network (lib/api/org.ts
 * calls it): a body as the Automations routes take it, with Cursor's
 * `modelSelection` read as `model`, and a list answered in both the API's
 * pages and Cursor's (`items`, `nextCursor`), so a script moved from
 * Cursor's PATCH /v1/automations/{id} and GET /v1/automations works as is.
 */

import { cursorPage, cursorPaging, isCursorOnlyModel } from "@/lib/api/cursor";
import { type PageRequest, pageRequest, paginate } from "@/lib/api/pagination";
import { topLevelCamel } from "@/lib/api/serialize";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The ids Cursor names an effort by among a model's `parameters`. */
const EFFORT_PARAMETERS = ["effort", "reasoning_effort", "thinking"];

/**
 * Cursor's `modelSelection` (`{ modelId, parameters: [{ id: "effort",
 * value }] }`) as an automation's `model`; null clears it, as does one of
 * Cursor's own ids (`default`, `auto`), which have no model here. The reason
 * when it can't be read.
 */
export function modelFromSelection(selection: unknown): Record<string, unknown> | null | string {
  if (selection === null) return null;
  const error = "`modelSelection` is `{ modelId, parameters }`, a model from GET /api/v1/models.";
  if (!isObject(selection)) return error;
  const id = selection.modelId ?? selection.model_id ?? selection.id;
  if (typeof id !== "string" || !id.trim()) return error;
  if (isCursorOnlyModel(id.trim())) return null;
  const parameters = selection.parameters ?? selection.params;
  let effort: unknown;
  if (parameters !== undefined && parameters !== null) {
    if (!Array.isArray(parameters) || !parameters.every(isObject)) return "`modelSelection.parameters` is a list of `{ id, value }`.";
    effort = parameters.find((p) => EFFORT_PARAMETERS.includes(String(p.id)))?.value;
  }
  return {
    id: id.trim(),
    ...(typeof selection.provider === "string" && { provider: selection.provider }),
    ...(effort !== undefined && { effort }),
  };
}

/** A POST or PATCH body as the Automations routes take it (camelCase at
 *  the top: `model` itself is `{ provider, id, effort }`), Cursor's
 *  `modelSelection` read as `model`; or the reason it's refused. */
export function automationBody(raw: Record<string, unknown>): Record<string, unknown> | string {
  const body = topLevelCamel(raw);
  if (body.modelSelection === undefined) return body;
  const { modelSelection, ...rest } = body;
  if (rest.model !== undefined) return "Send `model` or `modelSelection`, not both.";
  const model = modelFromSelection(modelSelection);
  if (typeof model === "string") return model;
  return { ...rest, model };
}

/** The page a list is asked for: `page` and `per_page`, or Cursor's
 *  `cursor` and `limit` when it names neither of those. */
export function automationsPage(params: URLSearchParams): PageRequest | string {
  const ours = params.has("page") || params.has("per_page");
  const cursors = params.has("cursor") || params.has("limit");
  return cursors && !ours ? cursorPaging(params) : pageRequest(params);
}

/** A page of the list, in the API's fields and, beside them, Cursor's. */
export function automationsList<T>(items: readonly T[], page: PageRequest): Record<string, unknown> {
  const answer = paginate(items, page);
  return { ...answer, ...cursorPage(answer.data, answer) };
}
