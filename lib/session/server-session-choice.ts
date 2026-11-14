/**
 * What a server session (lib/session/server-session.ts) is asked to start
 * on: Outrunner's models, or, asked to (`onHarness`), the user's own default
 * model and coding agent, falling back on Outrunner's when that can't start.
 */

import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import type { SessionRequest } from "@/lib/session/create-cloud-session";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";

/** Outrunner's models, on Outrunner's key (not `key: "own"`): the user's
 *  allowance, not their Claude or their own OpenRouter key. */
export function onOutrunner(start: Pick<ServerSessionStart, "model" | "prompt" | "branch">): SessionRequest {
  return { provider: "outrunner", model: start.model ?? OUTRUNNER_MODELS[0].id, prompt: start.prompt, ...(start.branch && { branch: start.branch }) };
}

/** No model or provider: the user's own default (personal, then the org's),
 *  as their new session with none picked starts on. */
export function onOwnDefault(start: Pick<ServerSessionStart, "prompt" | "branch">): SessionRequest {
  return { prompt: start.prompt, ...(start.branch && { branch: start.branch }) };
}

/**
 * Start it with `attempt` on what it's asked to run. On the user's own, a
 * refusal (no session made: signed out of Claude, say) starts it on
 * Outrunner's models instead, its `fellBack` saying why; one made is that
 * session, however it went, and never a second.
 */
export async function startOnChosen(
  start: Pick<ServerSessionStart, "model" | "prompt" | "branch" | "onHarness">,
  attempt: (request: SessionRequest) => Promise<ServerSessionResult>,
): Promise<ServerSessionResult> {
  if (!start.onHarness) return attempt(onOutrunner(start));
  const own = await attempt(onOwnDefault(start));
  if (own.status !== "refused") return own;
  const outrunner = await attempt(onOutrunner(start));
  if (outrunner.status === "refused") return outrunner;
  return { ...outrunner, fellBack: `Ran on Outrunner's models: it couldn't start on your own. ${own.errorMessage}` };
}
