/**
 * Handing a cloud session's agent what it signs in with (lib/agents/resolve.ts),
 * before it launches. A box's own setup holds the Claude credential the user
 * had when it was made; a session whose agent runs on anything else gets its
 * credential here, per session, so a key replaced since takes effect at the
 * session's next launch. A box whose agent predates what the session needs
 * (Codex, or a credential of its own) has its agent upgraded in place first,
 * where the provider can.
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
  /** Bring the box's agent up to this release's, in place; absent where the
   *  provider can't. */
  upgrade?(): Promise<void>;
};

/** The session's view of its box's agent; `upgrade` brings its agent up to
 *  date (ComputerRuntimeProvider.upgradeAgent). */
export function sessionAuthClient(
  client: AgentClient,
  identity: WorkspaceIdentity,
  upgrade?: () => Promise<void>,
): SessionAuthClient {
  return {
    setAuth: (credential) => client.setAuth(identity, credential),
    agents: async () => (await client.health(identity)).agents ?? null,
    ...(upgrade && { upgrade }),
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

/** What to say of a box that can't do what the session needs, its agent
 *  not upgraded here (the provider can't: a jcode engine). */
function outdated(what: string): OutdatedComputerError {
  return new OutdatedComputerError(`This project's cloud computer ${what}.`);
}

/** Whether a box whose agent says `agents` runs `agent`, and, when `mustTake`,
 *  takes a session's own credential (an agent from before the list doesn't). */
function fits(agents: AgentId[] | null, agent: AgentId, mustTake: boolean): boolean {
  return (agents ?? ["claude"]).includes(agent) && !(agents === null && mustTake);
}

/**
 * What the box's agent runs, upgraded in place first when it can't run
 * `agent` or (`mustTake`) take a credential the session must have, and the
 * provider can upgrade it. Still unfit after that: an
 * {@link OutdatedComputerError}.
 */
async function readyAgents(client: SessionAuthClient, agent: AgentId, mustTake: boolean): Promise<AgentId[] | null> {
  let agents = await client.agents();
  if (!fits(agents, agent, mustTake) && client.upgrade) {
    await client.upgrade();
    agents = await client.agents();
  }
  if (!(agents ?? ["claude"]).includes(agent)) throw outdated(`can't run ${AGENTS[agent].label}`);
  if (!fits(agents, agent, mustTake)) throw outdated(`can't sign ${AGENTS[agent].label} in the way you chose`);
  return agents;
}

/** Whether a session can't do without its credential: any of Codex's, and a
 *  Claude one the user picked (an unpicked one is the box's own). */
function mustTake(agent: AgentId, auth: ResolvedAuth): boolean {
  return auth.credential !== null && (agent !== "claude" || auth.picked);
}

/** Make sure the box runs `agent`, and takes the session's credential when it
 *  must, upgrading its agent in place where it can. */
export async function readyBox(client: SessionAuthClient, agent: AgentId, auth: ResolvedAuth): Promise<void> {
  await readyAgents(client, agent, mustTake(agent, auth));
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
  const agents = await readyAgents(client, agent, mustTake(agent, auth));
  const fallsBack = agent === "claude" && !auth.picked;
  if (!auth.credential || (agents === null && fallsBack)) {
    await restore();
    return;
  }
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
    if (!mustTake(agent, auth)) return;
    if (error instanceof AgentRequestError && error.status === 409) throw cantTake(agent);
    // An agent from before session credentials: upgraded, if it can be, to
    // one that takes it.
    await readyAgents(client, agent, true);
    await client.setAuth(auth.credential);
  }
}

/**
 * Sign an existing cloud session's agent in again before it relaunches (an
 * attach that starts it, a resume), as the user picks now: a key replaced, or
 * a pick changed, since it was made takes effect.
 */
export async function signInSession(client: SessionAuthClient, agent: AgentId, store: AgentAuthStore): Promise<void> {
  const auth = await resolveAgentAuth(store, agent, "cloud");
  await readyBox(client, agent, auth);
  await deliverSessionAuth(client, agent, auth);
}

/** What a route answers when a session's agent can't sign in: the message,
 *  and where in Settings it's fixed; null for any other error. */
export function signInFailure(error: unknown): { error: string; settingsHref?: string } | null {
  if (error instanceof AgentAuthError) return { error: error.message, settingsHref: error.settingsHref };
  if (error instanceof OutdatedComputerError) return { error: error.message };
  return null;
}
