/**
 * What a session's agent runs on: the way of signing in the user picked for
 * it (lib/agents/registry.ts), and the credential that way needs, or why it
 * can't run there. Never another way instead: a session on a credential the
 * user didn't pick would be billed to the wrong account.
 *
 * The storage is behind {@link AgentAuthStore}, so this tests without a
 * database (lib/db/agent-auth.ts is the real one).
 */

import {
  type AgentConnection,
  AGENTS,
  type AgentId,
  type AuthCredential,
  type AuthMethodId,
  authMethod,
  type RunTarget,
} from "@/lib/agents/registry";
import { PROVIDERS } from "@/lib/providers/registry";
import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";
import { providerSettingsHref } from "@/lib/settings-links";

/** A credential handed to the agent for one session (POST /workspaces/{id}/auth). */
export type SessionCredential = {
  kind: "claude-account" | "claude-oauth-token" | "anthropic-api-key" | "openai-api-key" | "codex-access-token" | "codex-account";
  token: string;
};

/**
 * What the session runs on. `credential` null: the agent's own login on the
 * Mac, or, with no `method`, what the box was set up with (the user has
 * picked nothing, and saved nothing a session here could run on: it can still
 * run on a model provider's key). `picked`: the user chose `method`, rather
 * than it being what the agent ran on before there was a choice, which a
 * box's own setup already holds.
 */
export type ResolvedAuth = { method: AuthMethodId | null; credential: SessionCredential | null; picked: boolean };

/** What the user picked for one agent, and the credentials it could need,
 *  opened only when asked for. */
export type AgentAuthState = {
  choice: AuthMethodId | null;
  /** A server broker may replace a direct provider credential for cloud sessions. */
  sessionCredential?(credential: AuthCredential): SessionCredential | null;
  /** The credential, or null when it isn't saved or can't be opened. */
  open(credential: AuthCredential): string | null;
};

export interface AgentAuthStore {
  load(agent: AgentId): Promise<AgentAuthState>;
}

export type AgentAuthReason = "local-only" | "not-connected";

/** Why a session's agent can't run on the way the user picked, and where in
 *  Settings → Providers to fix that. */
export class AgentAuthError extends Error {
  readonly agent: AgentId;
  readonly method: AuthMethodId;
  readonly reason: AgentAuthReason;
  readonly settingsHref: string;
  constructor(agent: AgentId, method: AuthMethodId, reason: AgentAuthReason) {
    super(agentAuthMessage(agent, method, reason));
    this.name = "AgentAuthError";
    this.agent = agent;
    this.method = method;
    this.reason = reason;
    this.settingsHref = providerSettingsHref(agent, method);
  }
}

function agentAuthMessage(agent: AgentId, method: AuthMethodId, reason: AgentAuthReason): string {
  const { label } = AGENTS[agent];
  const way = authMethod(agent, method);
  if (reason === "local-only") {
    return `${label} is set to sign in with ${way?.label ?? method}, which works for sessions on your Mac only. Choose API key under Personal → Coding agents → ${label} for sessions here.`;
  }
  const credential = way?.credential;
  if (credential?.kind === "claude-slot") {
    return `Connect your Claude subscription under Personal → Coding agents → ${label} to run it.`;
  }
  if (credential?.kind === "provider-key") {
    return `Save your ${PROVIDERS[credential.provider].label} API key under Personal → Coding agents → ${label} to run it.`;
  }
  return `Sign ${label} in under Personal → Coding agents → ${label} to run it.`;
}

/** The way an agent runs when the user hasn't picked one: as it did before
 *  there was a pick. Claude Code on a box runs on the subscription, else the
 *  Anthropic key; Codex on a box needs its key; on the Mac, each runs signed
 *  in as it is. Null: nothing a box could run it on. */
function fallbackMethod(agent: AgentId, target: RunTarget, state: AgentAuthState): AuthMethodId | null {
  if (target === "local") return "local";
  for (const method of AGENTS[agent].methods) {
    if (method.targets.includes("cloud") && method.credential.kind !== "own-login" && state.open(method.credential)) {
      return method.id;
    }
  }
  return null;
}

/** The way an agent signs in on a box that Settings offers first: what to
 *  connect when nothing is. */
function firstCloudMethod(agent: AgentId): AuthMethodId {
  return AGENTS[agent].methods.find((method) => method.targets.includes("cloud"))!.id;
}

/** The session credential for a way of signing in that needs one. */
function sessionCredential(credential: AuthCredential, token: string): SessionCredential | null {
  switch (credential.kind) {
    case "codex-account": return { kind: "codex-account", token };
    case "claude-slot":
      // The slot holds subscription tokens; one from before keys moved out of
      // it still runs as the API key it is.
      return { kind: anthropicEnvVar(token) === "CLAUDE_CODE_OAUTH_TOKEN" ? "claude-oauth-token" : "anthropic-api-key", token };
    case "provider-key":
      if (credential.provider === "anthropic") return { kind: "anthropic-api-key", token };
      if (credential.provider === "openai") return { kind: "openai-api-key", token };
      return null;
    case "own-login":
      return null;
  }
}

/** A pick this release knows; a later one's is no pick. */
function knownPick(agent: AgentId, state: AgentAuthState): AuthMethodId | null {
  return state.choice && authMethod(agent, state.choice) ? state.choice : null;
}

/**
 * What `agent` runs on for a session on `target`. Throws an
 * {@link AgentAuthError} when the user's pick can't run there: it runs on the
 * Mac only, or its credential isn't saved (or can't be opened). With
 * `ownAccount` false (the session runs a model on Outrunner's key or one of
 * the user's, which Claude Code reaches without signing in), a pick that
 * can't run there is no error: the session runs signed in to nothing.
 */
export async function resolveAgentAuth(
  store: AgentAuthStore,
  agent: AgentId,
  target: RunTarget,
  { ownAccount = true }: { ownAccount?: boolean } = {},
): Promise<ResolvedAuth> {
  const state = await store.load(agent);
  const picked = knownPick(agent, state);
  const method = picked ?? fallbackMethod(agent, target, state);
  const unsigned: ResolvedAuth = { method: null, credential: null, picked: false };
  const cantRun = (method: AuthMethodId, reason: AgentAuthReason) => {
    if (ownAccount) throw new AgentAuthError(agent, method, reason);
    return unsigned;
  };
  if (!method) {
    // Nothing picked, and nothing saved a box could run it on. Not the box's
    // own environment instead: it holds only what the user had saved when
    // the box was set up, which may since have been removed.
    return cantRun(firstCloudMethod(agent), "not-connected");
  }
  const way = authMethod(agent, method)!;
  if (!way.targets.includes(target)) return cantRun(method, "local-only");
  if (way.credential.kind === "own-login") return { method, credential: null, picked: picked !== null };
  const token = state.open(way.credential);
  if (!token) return cantRun(method, "not-connected");
  return { method, credential: state.sessionCredential?.(way.credential) ?? sessionCredential(way.credential, token), picked: picked !== null };
}

/**
 * Whether signing an existing session's agent in again, its model not known,
 * must have the agent's own account. Codex runs only on it. Claude Code may be
 * on a model on a key, which needs none: a session started on Outrunner's
 * models still opens after the user disconnects Claude, signed in to nothing.
 */
export function resignInNeedsAccount(agent: AgentId): boolean {
  return agent !== "claude";
}

/**
 * Where sessions can run on the user's own account of `agent` (Settings →
 * Providers), for the model menu: on a box (`cloud`), and on the Mac
 * (`local`: always, never, or `"mac-login"`, where the agent's CLI there is
 * logged in). Connected means the way picked has its credential saved, or is
 * the Mac's own login; with no pick, a credential saved for some way. With
 * nothing picked or saved, it is not connected anywhere, as Settings shows
 * it, though a session on the Mac would still run on the Mac's own login.
 */
export async function agentConnection(store: AgentAuthStore, agent: AgentId): Promise<AgentConnection> {
  const state = await store.load(agent);
  const picked = knownPick(agent, state);
  if (!picked) {
    // With no pick, a session on the Mac runs on its own login (fallbackMethod).
    const saved = fallbackMethod(agent, "cloud", state) !== null;
    return { cloud: saved, local: saved ? "mac-login" : false };
  }
  const way = authMethod(agent, picked)!;
  if (way.credential.kind === "own-login") return { cloud: false, local: "mac-login" };
  const saved = state.open(way.credential) !== null;
  return { cloud: saved && way.targets.includes("cloud"), local: saved && way.targets.includes("local") };
}
