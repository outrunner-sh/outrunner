import { AgentRequestError } from "@/lib/runtime/agent-client";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { NoProviderKeyError } from "@/lib/providers/errors";
import {
  type KeyHolder,
  type ModelProvider,
  predatesProvider,
  predatesProviderMessage,
  setModelRequest,
  type SessionModel,
  type SetModelRequest,
} from "@/lib/runtime/session-models";

/** No error envelope on a 404: the model route itself is missing, from an agent
 *  deployed before sessions could switch models. */
function predatesSwitching(error: unknown): boolean {
  return error instanceof AgentRequestError && error.status === 404 && !error.error;
}

/** What to tell the user when a cloud session's agent refuses or fails a switch
 *  to `model`, and the status to answer with. */
export function switchFailure(error: unknown, model: SessionModel): { status: number; message: string } {
  // An agent from before the model's provider: it says "unknown gateway".
  if (error instanceof AgentRequestError && error.status === 400 && predatesProvider(error.error?.message)) {
    return { status: 409, message: predatesProviderMessage(model) };
  }
  // Mid-turn, or tmux couldn't say: the agent's message says what to do.
  if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
    return { status: 409, message: error.error.message };
  }
  if (predatesSwitching(error)) {
    return {
      status: 409,
      message: "This project's cloud computer runs an older Outrunner that can't switch models.",
    };
  }
  return { status: 502, message: "Couldn't switch models. Please try again." };
}

/** A new session has no model to start on: Outrunner's are out of reach, and
 *  the user has no Claude login to fall back on. The message is for the user. */
export class NoStartingModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoStartingModelError";
  }
}

/**
 * Put a new cloud session on its model before Claude first launches, so it
 * starts there: the one chosen on the new-session screen, else the menu's
 * default (lib/runtime/session-models.ts defaultModel). When the default
 * can't be had (no key, a provider refusing, a box whose agent predates
 * switching or the provider), or there is none, the session starts on the
 * user's Claude login instead, or fails without one; a model the user chose
 * fails rather than quietly becoming another. Returns who it starts on.
 */
export async function startingModel(deps: {
  setModel: (req: SetModelRequest) => Promise<unknown>;
  keyFor: (holder: KeyHolder) => Promise<string>;
  hasClaude: boolean;
  /** Chosen on the new-session screen. */
  model?: SessionModel;
  /** What it starts on when none is chosen; null for the user's Claude. */
  fallback: SessionModel | null;
}): Promise<ModelProvider> {
  const chosen = deps.model ?? deps.fallback;
  if (!chosen || chosen.provider === "claude") {
    if (!deps.hasClaude) {
      throw new NoStartingModelError(
        chosen
          ? "Connect Claude in Settings to start a session on your Claude account."
          : "Outrunner's models aren't available on this server. Connect Claude in Settings to start a session.",
      );
    }
    // The menu's Claude model, or none: the session's own default.
    if (chosen) await deps.setModel({ model: chosen.id });
    return "claude";
  }
  try {
    await deps.setModel(await setModelRequest(chosen, deps.keyFor));
    return chosen.provider;
  } catch (error) {
    if (deps.hasClaude && !deps.model) {
      console.warn(`A new session starts on Claude: its default, ${chosen.id} (${chosen.provider}), was unavailable`, error);
      return "claude";
    }
    throw new NoStartingModelError(startFailure(error, chosen));
  }
}

/** Why a new session couldn't start on `model`, for the user. */
function startFailure(error: unknown, model: SessionModel): string {
  if (predatesSwitching(error)) {
    return "This project's cloud computer runs an older Outrunner that can't switch models. Connect Claude in Settings to use it.";
  }
  if (error instanceof AgentRequestError && error.status === 400 && predatesProvider(error.error?.message)) {
    return predatesProviderMessage(model);
  }
  if (error instanceof OutrunnerModelsUnavailableError) {
    return "Outrunner's models aren't available on this server. Connect Claude in Settings to start a session.";
  }
  if (error instanceof ModelKeyRefusedError || error instanceof NoProviderKeyError) return error.message;
  return `Couldn't start the session on ${model.label}. Please try again, or connect Claude in Settings.`;
}
