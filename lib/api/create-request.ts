/**
 * A request to start a session through the public API (POST /workspaces),
 * checked, and the prompt the session is sent first. No network here
 * (lib/api/workspaces.ts makes the session).
 */

import { isUuid } from "@/lib/ids";
import { isBoxSizeId } from "@/lib/runtime/box-sizes";

/** What a session started with `plan_mode` is told before its prompt. */
export const PLAN_MODE_PREAMBLE =
  "Plan first. Read what you need and reply with a plan for the task below, then stop and wait: don't change any files, commit or push until you're told to go ahead.";

export const MAX_PROMPT = 100_000;

/** A create request, checked. */
export type CreateInput = {
  projectId: string | null;
  environmentId: string | null;
  prompt: string;
  planMode: boolean;
  model?: string;
  provider?: string;
  effort?: string;
  agent?: string;
  size?: string;
  branch?: string;
  baseBranch?: string;
  /** Kept for the webhooks (lib/api/webhooks.ts). */
  webhookUrl: string | null;
};

function optionalString(raw: Record<string, unknown>, key: string): string | undefined | null {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A create request as posted, or the reason it's refused. */
export function parseCreate(raw: Record<string, unknown>): CreateInput | string {
  const projectId = optionalString(raw, "project_id");
  const environmentId = optionalString(raw, "environment_id");
  if (projectId === null || environmentId === null) return "`project_id` and `environment_id` must be ids.";
  if (!projectId && !environmentId) return "Name the repository to work on (`project_id`) or a project (`environment_id`).";
  if (projectId && environmentId) return "Name either `project_id` or `environment_id`, not both.";
  if ((projectId && !isUuid(projectId)) || (environmentId && !isUuid(environmentId))) return "That id isn't one.";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return "Say what the session should do (`prompt`).";
  if (prompt.length > MAX_PROMPT) return "The prompt is too long.";
  if (raw.plan_mode !== undefined && typeof raw.plan_mode !== "boolean") return "`plan_mode` is true or false.";
  const fields: Record<string, string | undefined> = {};
  for (const key of ["model", "provider", "effort", "agent", "size", "branch", "base_branch", "webhook_url"]) {
    const value = optionalString(raw, key);
    if (value === null) return `\`${key}\` must be text.`;
    fields[key] = value;
  }
  if (fields.size && !isBoxSizeId(fields.size)) return "`size` is x-small, small, medium or large.";
  if (fields.agent && fields.agent !== "claude" && fields.agent !== "codex") return "`agent` is claude or codex.";
  if (fields.agent && !fields.model) return "Name the `model` the agent runs, with `agent`.";
  return {
    projectId: projectId ?? null,
    environmentId: environmentId ?? null,
    prompt,
    planMode: raw.plan_mode === true,
    model: fields.model,
    provider: fields.provider,
    effort: fields.effort,
    agent: fields.agent,
    size: fields.size,
    branch: fields.branch,
    baseBranch: fields.base_branch,
    webhookUrl: fields.webhook_url ?? null,
  };
}

/** The prompt a session is sent first. */
export function firstPrompt(input: Pick<CreateInput, "prompt" | "planMode">): string {
  return input.planMode ? `${PLAN_MODE_PREAMBLE}\n\n${input.prompt}` : input.prompt;
}
