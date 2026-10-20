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
 * Sign the agent of local session `workspaceId` in, before it launches. A
 * credential goes to the agent on this Mac; a pick of the Mac's own login
 * needs this Mac's CLI installed and signed in. Claude Code's own login is
 * checked where it always was (the new-session page), so only Codex's here.
 * `status` is what the Mac app last reported.
 */
export async function signInLocalAgent(workspaceId: string, agent: AgentId, status: LocalStatus | null): Promise<void> {
  const auth = await resolveLocal(agent);
  if (auth.credential) {
    await localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/auth`, auth.credential);
    return;
  }
  if (agent === "claude" || !status) return;
  const href = providerSettingsHref(agent, auth.method ?? undefined);
  const { label } = AGENTS[agent];
  if (!status.agents) {
    throw new LocalAgentAuthError(`Update the Outrunner app to run ${label} on this Mac.`, href);
  }
  switch (localAgentState(status, agent)) {
    case "missing":
      throw new LocalAgentAuthError(
        `Install ${label} to run it on this Mac: run \`${CODEX_INSTALL_COMMAND}\` in Terminal, then try again.`,
        href,
      );
    case "logged-out":
      throw new LocalAgentAuthError(`Sign ${label} in on this Mac first, in Settings → Providers → ${label}.`, href);
    case "ready":
      return;
  }
}
