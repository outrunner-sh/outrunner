/**
 * Handing a cloud session's agent what it signs in with (lib/agents/resolve.ts),
 * before it launches. A box's own setup holds the Claude credential the user
 * had when it was made; a session whose agent runs on anything else gets its
 * credential here, per session, so a key replaced since takes effect at the
 * session's next launch.
 */

import { AGENTS, type AgentId } from "@/lib/agents/registry";
import {
  AgentAuthError,
  type AgentAuthStore,
  resolveAgentAuth,
  type ResolvedAuth,
  type SessionCredential,
} from "@/lib/agents/resolve";
import { type AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";

/** The parts of the agent's client this needs, so it tests with a stand-in. */
export type SessionAuthClient = {
  setAuth(credential: SessionCredential): Promise<unknown>;
  /** The agents the box can run (GET /health); null from an agent from
   *  before the list, which runs Claude Code alone and takes no per-session
   *  credential. */
  agents(): Promise<AgentId[] | null>;
};

/** The session's view of its box's agent. */
export function sessionAuthClient(client: AgentClient, identity: WorkspaceIdentity): SessionAuthClient {
  return {
    setAuth: (credential) => client.setAuth(identity, credential),
    agents: async () => (await client.health(identity)).agents ?? null,
  };
}

/** A box running an Outrunner from before what the session needs: an agent
 *  it can't run, or per-session credentials. The message is for the user. */
export class OutdatedComputerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutdatedComputerError";
  }
}

/** What to say: the box takes the new Outrunner when it next starts, which
 *  it does after being paused for idling. */
function outdated(what: string): OutdatedComputerError {
  return new OutdatedComputerError(
    `This project's cloud computer runs an older Outrunner that ${what}. It updates the next time it starts, after it has been paused for being idle; try again then.`,
  );
}

/** Refuse a box that can't run `agent`. Claude Code runs on every one. */
export async function requireAgentOnBox(client: SessionAuthClient, agent: AgentId): Promise<void> {
  if (agent === "claude") return;
  if (!((await client.agents()) ?? ["claude"]).includes(agent)) throw outdated(`can't run ${AGENTS[agent].label}`);
}

/**
 * Run a restore, which relaunches the session at once, so its credential
 * rides with it (there's no /auth call between): `restore` makes the call,
 * with the credential or without. A credential goes to every agent that can
 * take one, so a key replaced while the box ran is the one the session
 * relaunches on. One that can't (an agent from before per-session
 * credentials, or a jcode engine) is fine only for a Claude credential the
 * user never picked (the box's own setup holds it): the restore goes ahead
 * without it. For any other, an {@link OutdatedComputerError}.
 */
export async function restoreSignedIn(
  client: SessionAuthClient,
  agent: AgentId,
  auth: ResolvedAuth,
  restore: (credential?: SessionCredential) => Promise<unknown>,
): Promise<void> {
  const agents = await client.agents();
  if (!(agents ?? ["claude"]).includes(agent)) throw outdated(`can't run ${AGENTS[agent].label}`);
  const fallsBack = agent === "claude" && !auth.picked;
  if (!auth.credential || (agents === null && fallsBack)) {
    await restore();
    return;
  }
  if (agents === null) throw outdated(`can't sign ${AGENTS[agent].label} in the way you chose`);
  try {
    await restore(auth.credential);
  } catch (error) {
    if (!takesNoSessionAuth(error)) throw error;
    // Refused before anything was restored: the engine takes no credential.
    if (!fallsBack) throw cantTake(agent);
    await restore();
  }
}

/** What to say of an engine that runs every session on its own login. */
function cantTake(agent: AgentId): OutdatedComputerError {
  return new OutdatedComputerError(
    `This project's cloud computer runs every session on its own login, so ${AGENTS[agent].label} can't sign in the way you chose there.`,
  );
}

/** An agent that can't take a session's credential: one from before sessions
 *  had them (a 404 with no error envelope: the route itself is missing), or
 *  one on an engine that runs every session on its own login (jcode: 409
 *  UNSUPPORTED). */
function takesNoSessionAuth(error: unknown): boolean {
  if (!(error instanceof AgentRequestError)) return false;
  return (error.status === 404 && !error.error) || (error.status === 409 && error.error?.code === "UNSUPPORTED");
}

/**
 * Give the session `auth`'s credential, if it has one. An agent from before
 * per-session credentials, or on an engine that runs every session on its own
 * login, can't take it: that is fine for a credential the
 * user never picked (the box's own setup holds the same one), and an
 * {@link OutdatedComputerError} for one they did, which the session would
 * otherwise run without, on another account.
 */
export async function deliverSessionAuth(client: SessionAuthClient, agent: AgentId, auth: ResolvedAuth): Promise<void> {
  if (!auth.credential) return;
  try {
    await client.setAuth(auth.credential);
  } catch (error) {
    if (!takesNoSessionAuth(error)) throw error;
    if (agent === "claude" && !auth.picked) return;
    if (error instanceof AgentRequestError && error.status === 409) throw cantTake(agent);
    throw outdated(`can't sign ${AGENTS[agent].label} in the way you chose`);
  }
}

/**
 * Sign an existing cloud session's agent in again before it relaunches (an
 * attach that starts it, a resume), as the user picks now: a key replaced, or
 * a pick changed, since it was made takes effect.
 */
export async function signInSession(client: SessionAuthClient, agent: AgentId, store: AgentAuthStore): Promise<void> {
  await deliverSessionAuth(client, agent, await resolveAgentAuth(store, agent, "cloud"));
}

/** What a route answers when a session's agent can't sign in: the message,
 *  and where in Settings it's fixed; null for any other error. */
export function signInFailure(error: unknown): { error: string; settingsHref?: string } | null {
  if (error instanceof AgentAuthError) return { error: error.message, settingsHref: error.settingsHref };
  if (error instanceof OutdatedComputerError) return { error: error.message };
  return null;
}
