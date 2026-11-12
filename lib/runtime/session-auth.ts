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
  resignInNeedsAccount,
  resolveAgentAuth,
  type ResolvedAuth,
  type SessionCredential,
} from "@/lib/agents/resolve";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { type AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CODEX_ACCESS_TOKEN, AGENT_FEATURE_CODEX_ACCOUNT } from "@/lib/runtime/agent-protocol";
import { SessionKeyRemovedError } from "@/lib/runtime/model-switch";
import { type RecordedModel, runsOnOwnAccount } from "@/lib/runtime/session-models";

/** What takes a session's credential away: its agent's own login, or the
 *  agent's environment, applies again (for a session on a model on a key,
 *  which its gateway overrides, nothing does). */
const SIGNED_OUT = { kind: "none" } as const;

/** The parts of the agent's client this needs, so it tests with a stand-in. */
export type SessionAuthClient = {
  setAuth(credential: SessionCredential | typeof SIGNED_OUT): Promise<unknown>;
  /** The agents the box can run (GET /health); null from an agent from
   *  before the list, which runs Claude Code alone and takes no per-session
   *  credential. */
  agents(): Promise<AgentId[] | null>;
  /** New credential kinds need an explicit capability, even on a box that
   *  already runs Codex and accepts its older API-key credential. */
  features?(): Promise<string[]>;
  /** Bring the box's agent up to this release's, in place; absent where the
   *  provider can't. */
  upgrade?(): Promise<void>;
};

/** The session's view of its box's agent; `upgrade` brings its agent up to
 *  date (ComputerRuntimeProvider.upgradeAgent). With `chat`, the view of one
 *  of its chats', whose credential is its own. */
export function sessionAuthClient(
  client: AgentClient,
  identity: WorkspaceIdentity,
  upgrade?: () => Promise<void>,
  chat?: string,
): SessionAuthClient {
  return {
    setAuth: (credential) => client.setAuth(identity, credential, chat),
    agents: async () => (await client.health(identity)).agents ?? null,
    features: async () => (await client.health(identity)).features ?? [],
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
 *  not upgraded here. */
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
  await readyCredential(client, auth);
}

/** Refuse before writing auth or restoring anything on an older runtime.
 *  A Codex workspace token must never be treated as a Platform API key. */
async function readyCredential(client: SessionAuthClient, auth: ResolvedAuth): Promise<void> {
  const kind = auth.credential?.kind;
  if (kind !== "codex-access-token" && kind !== "codex-account") return;
  const feature = kind === "codex-account" ? AGENT_FEATURE_CODEX_ACCOUNT : AGENT_FEATURE_CODEX_ACCESS_TOKEN;
  const supports = async () => (await client.features?.() ?? []).includes(feature);
  if (await supports()) return;
  if (client.upgrade) {
    await client.upgrade();
    if (await supports()) return;
  }
  throw outdated(`can't sign Codex in with ${kind === "codex-account" ? "a ChatGPT account" : "a workspace access token"}`);
}

/**
 * Run a restore, which relaunches the session at once, so its credential
 * rides with it (there's no /auth call between): `restore` makes the call,
 * with the credential or without. A credential goes to every agent that can
 * take one, so a key replaced while the box ran is the one the session
 * relaunches on. One that can't (an agent from before per-session
 * credentials, or one on its own login) is fine only for a Claude credential the
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
  await readyCredential(client, auth);
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
 *  one on an engine that runs every session on its own login (409
 *  UNSUPPORTED). */
function takesNoSessionAuth(error: unknown): boolean {
  if (!(error instanceof AgentRequestError)) return false;
  return (error.status === 404 && !error.error) || (error.status === 409 && error.error?.code === "UNSUPPORTED");
}

/**
 * Give the session `auth`'s credential, or with none take away the one it
 * had: a credential removed (or a pick changed) since it was given must not
 * be what the session relaunches on. An agent from before per-session
 * credentials, or on an engine that runs every session on its own login,
 * can't take one: that is fine for a credential the user never picked (the
 * box's own setup holds the same one), and an {@link OutdatedComputerError}
 * for one they did, which the session would otherwise run without, on
 * another account. Neither has one to take away.
 */
export async function deliverSessionAuth(client: SessionAuthClient, agent: AgentId, auth: ResolvedAuth): Promise<void> {
  // Delivery is also used without readyBox (resume/switch). Keep its own
  // capability check: create pays a second health request rather than reusing
  // a preflight result across intervening runtime/restore operations. A failed
  // readyBox throws before creation reaches this boundary.
  await readyCredential(client, auth);
  if (!auth.credential) {
    try {
      await client.setAuth(SIGNED_OUT);
    } catch (error) {
      if (!takesNoSessionAuth(error)) throw error;
    }
    return;
  }
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
 * Whether a session relaunching on `recorded` (its row's model) needs its
 * agent's own account: on the user's Claude, or Codex, it does; on a model
 * on a key, it doesn't. A session from before models were recorded, as
 * {@link resignInNeedsAccount}.
 */
export function relaunchNeedsAccount(agent: AgentId, recorded: RecordedModel | null): boolean {
  return recorded ? runsOnOwnAccount(recorded.model) : resignInNeedsAccount(agent);
}

/**
 * Sign an existing cloud session's agent in again before it relaunches (an
 * attach that starts it, a resume, a switch), as the user picks now: a key
 * replaced, or a pick changed, since it was made takes effect, and one
 * removed is taken away. `ownAccount` as resolveAgentAuth takes it (see
 * {@link relaunchNeedsAccount}): by default, as {@link resignInNeedsAccount}.
 */
export async function signInSession(
  client: SessionAuthClient,
  agent: AgentId,
  store: AgentAuthStore,
  ownAccount = resignInNeedsAccount(agent),
): Promise<void> {
  const auth = await resolveAgentAuth(store, agent, "cloud", { ownAccount });
  await readyBox(client, agent, auth);
  await deliverSessionAuth(client, agent, auth);
}

/** What a route answers when a session's agent can't sign in, or its model's
 *  key can't be had: the message, and where in Settings it's fixed when the
 *  user can fix it there; null for any other error. */
export function signInFailure(error: unknown): { error: string; settingsHref?: string } | null {
  if (error instanceof AgentAuthError || error instanceof SessionKeyRemovedError) {
    return { error: error.message, settingsHref: error.settingsHref };
  }
  if (
    error instanceof OutdatedComputerError ||
    error instanceof ModelKeyRefusedError ||
    error instanceof OutrunnerModelsUnavailableError
  ) {
    return { error: error.message };
  }
  return null;
}

