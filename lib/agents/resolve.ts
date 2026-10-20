/**
 * What a session's agent runs on: the way of signing in the user picked for
 * it (lib/agents/registry.ts), and the credential that way needs, or why it
 * can't run there. Never another way instead: a session on a credential the
 * user didn't pick would be billed to the wrong account.
 *
 * The storage is behind {@link AgentAuthStore}, so this tests without a
 * database (lib/db/agent-auth.ts is the real one).
 */

import { AGENTS, type AgentId, type AuthCredential, type AuthMethodId, authMethod, type RunTarget } from "@/lib/agents/registry";
import { PROVIDERS } from "@/lib/providers/registry";
import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";
import { providerSettingsHref } from "@/lib/settings-links";

/** A credential handed to the agent for one session (POST /workspaces/{id}/auth). */
export type SessionCredential = {
  kind: "claude-oauth-token" | "anthropic-api-key" | "openai-api-key";
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
    return `${label} is set to sign in with ${way?.label ?? method}, which works for sessions on your Mac only. Choose API key under Settings → Providers → ${label} for sessions here.`;
  }
  const credential = way?.credential;
  if (credential?.kind === "claude-slot") {
    return `Connect your Claude subscription under Settings → Providers → ${label} to run it.`;
  }
  if (credential?.kind === "provider-key") {
    return `Save your ${PROVIDERS[credential.provider].label} API key under Settings → Providers → ${label} to run it.`;
  }
  return `Sign ${label} in under Settings → Providers → ${label} to run it.`;
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

/** The session credential for a way of signing in that needs one. */
function sessionCredential(credential: AuthCredential, token: string): SessionCredential | null {
  switch (credential.kind) {
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

/**
 * What `agent` runs on for a session on `target`. Throws an
 * {@link AgentAuthError} when the user's pick can't run there: it runs on the
 * Mac only, or its credential isn't saved (or can't be opened).
 */
export async function resolveAgentAuth(
  store: AgentAuthStore,
  agent: AgentId,
  target: RunTarget,
): Promise<ResolvedAuth> {
  const state = await store.load(agent);
  // A pick this release doesn't know (a later one's) is no pick.
  const picked = state.choice && authMethod(agent, state.choice) ? state.choice : null;
  const method = picked ?? fallbackMethod(agent, target, state);
  if (!method) {
    // Codex has nothing else to run on; Claude Code still has the box's own
    // setup and the model providers.
    if (agent === "codex") throw new AgentAuthError(agent, "api-key", "not-connected");
    return { method: null, credential: null, picked: false };
  }
  const way = authMethod(agent, method)!;
  if (!way.targets.includes(target)) throw new AgentAuthError(agent, method, "local-only");
  if (way.credential.kind === "own-login") return { method, credential: null, picked: picked !== null };
  const token = state.open(way.credential);
  if (!token) throw new AgentAuthError(agent, method, "not-connected");
  return { method, credential: sessionCredential(way.credential, token), picked: picked !== null };
}
