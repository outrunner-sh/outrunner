/**
 * What a new session starts on, chosen in Settings → Models: on this Mac, the
 * agent (Claude Code or Codex) and its model; in the cloud, the model. Stored
 * in the user's metadata. No imports beyond the model lists, so it unit-tests
 * alone.
 */

import { CLAUDE_MODELS, offeredModel } from "@/lib/runtime/session-models";

export type LocalAgent = "claude" | "codex";

export type SessionDefaults = {
  /** This Mac. A null model is the agent's own default. */
  local: { agent: LocalAgent; model: string | null };
  /** The cloud. A null model is Outrunner's default (DEFAULT_CLOUD_MODEL). */
  cloud: { model: string | null };
};

/** Nothing chosen: Claude Code on this Mac, Outrunner's model in the cloud. */
export const NO_DEFAULTS: SessionDefaults = {
  local: { agent: "claude", model: null },
  cloud: { model: null },
};

/** A model id as the agent accepts one (claude.ValidModel): never an option. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]~-]{0,99}$/;

/**
 * Stored defaults, made safe to use: anything unknown or malformed falls back
 * to NO_DEFAULTS' value for it. Claude Code's model must be one of its menu's,
 * the cloud's one of the cloud menu's. A Codex model is whatever Codex lists
 * for the login, which changes with Codex itself, so only its shape is checked.
 */
export function parseSessionDefaults(raw: unknown): SessionDefaults {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const local = obj(obj(raw).local);
  const cloud = obj(obj(raw).cloud);
  const agent: LocalAgent = local.agent === "codex" ? "codex" : "claude";
  const localModel =
    typeof local.model !== "string"
      ? null
      : agent === "codex"
        ? MODEL_ID.test(local.model)
          ? local.model
          : null
        : CLAUDE_MODELS.some((m) => m.id === local.model)
          ? local.model
          : null;
  const cloudModel = offeredModel(cloud.model) ? (cloud.model as string) : null;
  return { local: { agent, model: localModel }, cloud: { model: cloudModel } };
}
