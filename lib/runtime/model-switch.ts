import { AgentRequestError } from "@/lib/runtime/agent-client";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { NoProviderKeyError } from "@/lib/providers/errors";
import { isProviderId, PROVIDERS } from "@/lib/providers/registry";
import {
  checkEffortApplied,
  CLAUDE_DEFAULT_MODEL,
  DEFAULT_EFFORT,
  type Effort,
  EffortUnsupportedError,
  type KeyHolder,
  predatesProvider,
  predatesProviderMessage,
  setModelRequest,
  type RecordedModel,
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
  if (error instanceof EffortUnsupportedError) return { status: 409, message: error.message };
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

/** Why a session can't start where the server runs none of Outrunner's
 *  models: it needs the user's Claude, or a key of their own. Said where the
 *  menu is empty, not "Connect Claude" alone: a key is just as good. */
export const NO_OUTRUNNER_MODELS =
  "Outrunner's models aren't available on this server. Connect Claude or add a provider key in Settings to start a session.";

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
 * user's Claude login instead, on CLAUDE_DEFAULT_MODEL at DEFAULT_EFFORT, or
 * fails without one; a model the user chose fails rather than quietly
 * becoming another. Returns what it starts on, for the session's row to
 * record (recordWorkspaceModel): the model, and the effort sent with it.
 */
export async function startingModel(deps: {
  /** Resolves to the agent's answer, which says the effort it applied. */
  setModel: (req: SetModelRequest) => Promise<unknown>;
  keyFor: (holder: KeyHolder) => Promise<string>;
  hasClaude: boolean;
  /** Chosen on the new-session screen. */
  model?: SessionModel;
  /** Chosen with it; it goes only with a model that takes one. */
  effort?: Effort;
  /** What it starts on when none is chosen; null for the user's Claude. */
  fallback: SessionModel | null;
}): Promise<RecordedModel> {
  const chosen = deps.model ?? deps.fallback;
  // The effort was picked for the chosen model, never for the fallback.
  const effort = deps.model ? deps.effort : undefined;
  const put = async (model: SessionModel): Promise<RecordedModel> => {
    const req = await setModelRequest(model, deps.keyFor, effort);
    checkEffortApplied(req, await deps.setModel(req));
    return { model, effort: req.effort ?? null };
  };
  // Nothing picked, on the user's Claude. Best effort: a box whose agent
  // predates switching, or efforts, still starts, on Claude Code's own. Said
  // to be on Opus either way: what its row needs is that it runs on the
  // user's Claude.
  const onClaudeDefault: RecordedModel = { model: CLAUDE_DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  const putOnClaudeDefault = async (): Promise<RecordedModel> => {
    try {
      const req = await setModelRequest(CLAUDE_DEFAULT_MODEL, deps.keyFor, DEFAULT_EFFORT);
      checkEffortApplied(req, await deps.setModel(req));
    } catch (error) {
      console.warn("A new session starts on Claude Code's own default model: the agent couldn't set Opus", error);
    }
    return onClaudeDefault;
  };
  if (!chosen || chosen.provider === "claude") {
    if (!deps.hasClaude) {
      throw new NoStartingModelError(
        chosen
          ? "Connect Claude in Settings to start a session on your Claude account."
          : NO_OUTRUNNER_MODELS,
      );
    }
    return chosen ? put(chosen) : putOnClaudeDefault();
  }
  try {
    return await put(chosen);
  } catch (error) {
    if (deps.hasClaude && !deps.model) {
      console.warn(`A new session starts on Claude: its default, ${chosen.id} (${chosen.provider}), was unavailable`, error);
      return putOnClaudeDefault();
    }
    throw new NoStartingModelError(startFailure(error, chosen));
  }
}

/** Why a new session couldn't start on `model`, for the user. */
function startFailure(error: unknown, model: SessionModel): string {
  if (error instanceof EffortUnsupportedError) return error.message;
  if (predatesSwitching(error)) {
    return "This project's cloud computer runs an older Outrunner that can't switch models. Connect Claude in Settings to use it.";
  }
  if (error instanceof AgentRequestError && error.status === 400 && predatesProvider(error.error?.message)) {
    return predatesProviderMessage(model);
  }
  if (error instanceof OutrunnerModelsUnavailableError) {
    return NO_OUTRUNNER_MODELS;
  }
  if (error instanceof ModelKeyRefusedError || error instanceof NoProviderKeyError) return error.message;
  return `Couldn't start the session on ${model.label}. Please try again, or connect Claude in Settings.`;
}

/** A session on a model on the user's own key, relaunching after that key
 *  was removed: it doesn't, rather than run on another. The message is for
 *  the user, and says where to fix it. */
export class SessionKeyRemovedError extends Error {
  readonly settingsHref: string;
  constructor(model: SessionModel, cause: NoProviderKeyError) {
    super(
      `This session runs ${model.label} on your ${PROVIDERS[cause.provider].label} key, which isn't saved anymore. Save it again in Personal → Coding agents, or switch the session to another model.`,
    );
    this.name = "SessionKeyRemovedError";
    this.settingsHref = cause.settingsHref;
  }
}

/** The agent request that puts a session back on `recorded`, its row's
 *  model, its key fetched now: one the user removed since is a
 *  {@link SessionKeyRemovedError}. */
export async function recordedModelRequest(
  recorded: RecordedModel,
  keyFor: (holder: KeyHolder) => Promise<string>,
): Promise<SetModelRequest> {
  try {
    // Persisted effort is an explicit session choice, not a newly inferred
    // capability. Preserve it on restore; the runtime may refuse an obsolete
    // value, but must not silently launch at a different saved effort.
    const model = recorded.model.provider === "codex" && recorded.effort
      ? { ...recorded.model, efforts: [recorded.effort] } : recorded.model;
    return await setModelRequest(model, keyFor, recorded.effort);
  } catch (error) {
    if (error instanceof NoProviderKeyError) throw new SessionKeyRemovedError(recorded.model, error);
    throw error;
  }
}

/**
 * Put a session about to relaunch on the box it ran on (a resume, an attach
 * that starts it) back on `recorded`, its row's model, with its key fetched
 * again: a key the user replaced is the one it relaunches on, and one they
 * removed stops it ({@link SessionKeyRemovedError}).
 *
 * Only a model on a key of the user's own. Outrunner's key stays the user's
 * from launch to launch, and OpenRouter caps it, so a session on it relaunches
 * on the one its box has; one on its agent's own account is signed in by
 * signInSession. A session from before models were recorded relaunches as it
 * did. One running mid-turn keeps the key it has until it next relaunches.
 */
export async function putBackOnModel(
  deps: {
    setModel: (req: SetModelRequest) => Promise<unknown>;
    keyFor: (holder: KeyHolder) => Promise<string>;
  },
  recorded: RecordedModel | null,
): Promise<void> {
  if (!recorded || !isProviderId(recorded.model.provider)) return;
  const req = await recordedModelRequest(recorded, deps.keyFor);
  try {
    await deps.setModel(req);
  } catch (error) {
    if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
      console.warn(`A running session keeps its ${recorded.model.provider} key until it next relaunches: ${error.error.message}`);
      return;
    }
    throw error;
  }
}
