/**
 * Signing a new local session's agent in, the way the user picked for it
 * (Settings → Providers, lib/agents/resolve.ts): with a credential from the
 * server, handed to the agent on this Mac, or with the Mac's own login of the
 * agent's CLI, which has to be there.
 */

import { AGENTS, type AgentId } from "@/lib/agents/registry";
import type { ResolvedAuth } from "@/lib/agents/resolve";
import {
  CODEX_INSTALL_COMMAND,
  localAgentRequest,
  localAgentState,
  type LocalStatus,
  localTarget,
} from "@/lib/desktop/local-runtime";
import { providerSettingsHref } from "@/lib/settings-links";

/** Why a local session's agent can't sign in, and where in Settings the user
 *  fixes that. */
export class LocalAgentAuthError extends Error {
  readonly settingsHref: string;
  constructor(message: string, settingsHref: string) {
    super(message);
    this.name = "LocalAgentAuthError";
    this.settingsHref = settingsHref;
  }
}

/** What the server says the agent signs in with, for a session on this Mac. */
async function resolveLocal(agent: AgentId): Promise<ResolvedAuth> {
  let res: Response;
  try {
    res = await fetch("/api/agents/session-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
  } catch {
    throw new Error("Could not reach Outrunner. Please try again.");
  }
  const data = (await res.json().catch(() => null)) as (ResolvedAuth & { error?: string; settingsHref?: string }) | null;
  if (!res.ok || !data) {
    const message = data?.error ?? `Couldn't read how ${AGENTS[agent].label} signs in. Try again.`;
    if (data?.settingsHref) throw new LocalAgentAuthError(message, data.settingsHref);
    throw new Error(message);
  }
  return data;
}

/**
 * Hand local session `workspaceId`'s agent its credential, as the user picks
 * now, before it (re)launches: so a key replaced since is the one it runs on.
 * A pick with no credential (the Mac's own login) takes a saved one away. An
 * app from before session credentials can't relay that, and has none saved
 * to take away, so that refusal is no failure; it is for a credential, which
 * the session would otherwise run without.
 */
export async function deliverLocalAgentAuth(workspaceId: string, agent: AgentId): Promise<ResolvedAuth> {
  const auth = await resolveLocal(agent);
  const target = localTarget(workspaceId);
  const path = `/workspaces/${workspaceId}/auth`;
  if (auth.credential) {
    await localAgentRequest(target, "POST", path, auth.credential);
  } else {
    await localAgentRequest(target, "POST", path, { kind: "none" }).catch(() => {});
  }
  return auth;
}

/**
 * Sign a new local session's agent in. Codex must be on this Mac whichever way
 * it signs in, and signed in there when the pick is the Mac's own login.
 * Claude Code's own login is checked where it always was (the new-session
 * page). `status` is what the Mac app last reported.
 */
export async function signInLocalAgent(workspaceId: string, agent: AgentId, status: LocalStatus | null): Promise<void> {
  if (agent === "codex" && status) {
    const href = providerSettingsHref(agent);
    if (!status.agents) throw new LocalAgentAuthError("Update the Outrunner app to run Codex on this Mac.", href);
    if (localAgentState(status, agent) === "missing") {
      throw new LocalAgentAuthError(
        `Install Codex to run it on this Mac: run \`${CODEX_INSTALL_COMMAND}\` in Terminal, then try again.`,
        href,
      );
    }
  }
  const auth = await deliverLocalAgentAuth(workspaceId, agent);
  if (agent === "codex" && !auth.credential && status && localAgentState(status, agent) === "logged-out") {
    throw new LocalAgentAuthError(
      `Sign ${AGENTS[agent].label} in on this Mac first, in Settings → Providers → ${AGENTS[agent].label}.`,
      providerSettingsHref(agent, auth.method ?? undefined),
    );
  }
}
