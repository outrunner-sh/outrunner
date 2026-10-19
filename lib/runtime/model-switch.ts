import { AgentRequestError } from "@/lib/runtime/agent-client";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import {
  DEFAULT_CLOUD_MODEL,
  setModelRequest,
  type SessionModel,
  type SetModelRequest,
} from "@/lib/runtime/session-models";

/** No error envelope on a 404: the model route itself is missing, from an agent
 *  deployed before sessions could switch models. */
function predatesSwitching(error: unknown): boolean {
  return error instanceof AgentRequestError && error.status === 404 && !error.error;
}

/** What to tell the user when a cloud session's agent refuses or fails a model
 *  switch, and the status to answer with. */
export function switchFailure(error: unknown): { status: number; message: string } {
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
 * starts there: the one chosen on the new-session screen, else Outrunner's
 * default. When Outrunner's default can't be had (no OpenRouter key, OpenRouter
 * refusing, a box whose agent predates switching), the session starts on the
 * user's Claude login instead, or fails without one; a model the user chose
 * fails rather than quietly becoming another. Returns which it starts on.
 */
export async function startingModel(deps: {
  setModel: (req: SetModelRequest) => Promise<unknown>;
  openRouterKey: () => Promise<string>;
  hasClaude: boolean;
  /** Chosen on the new-session screen; omitted, Outrunner's default. */
  model?: SessionModel;
}): Promise<"outrunner" | "claude"> {
  const chosen = deps.model ?? DEFAULT_CLOUD_MODEL;
  if (chosen.source === "claude") {
    if (!deps.hasClaude) throw new NoStartingModelError("Connect Claude in Settings to start a session on your Claude account.");
    await deps.setModel({ model: chosen.id });
    return "claude";
  }
  try {
    const req = await setModelRequest(chosen.id, deps.openRouterKey);
    if (!req) throw new Error(`${chosen.id} is not on the menu`);
    await deps.setModel(req);
    return "outrunner";
  } catch (error) {
    if (deps.hasClaude && !deps.model) {
      console.warn("A new session starts on Claude: Outrunner's default model was unavailable", error);
      return "claude";
    }
    throw new NoStartingModelError(
      predatesSwitching(error)
        ? "This project's cloud computer runs an older Outrunner that can't run Outrunner's models. Connect Claude in Settings to use it."
        : error instanceof OutrunnerModelsUnavailableError
          ? "Outrunner's models aren't available on this server. Connect Claude in Settings to start a session."
          : error instanceof ModelKeyRefusedError
            ? error.message
            : "Couldn't start the session on Outrunner's models. Please try again, or connect Claude in Settings.",
    );
  }
}
