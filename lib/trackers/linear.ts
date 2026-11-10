/**
 * Linear's side of a connection: its OAuth, its webhook's signature, and the
 * few questions asked of its API. docs/linear-app.md sets the app up.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { optionalEnv } from "@/lib/env";
import { signPayload, verifyPayload } from "@/lib/slack/slack";
import { TrackerRevokedError, type TrackerTokens, TrackerUnauthorizedError, TrackerUnavailableError, TrackerRefusedError } from "@/lib/trackers/errors";
import { isClosedStateType } from "@/lib/trackers/rules";

export const LINEAR_CALLBACK_PATH = "/api/integrations/linear/callback";
/** The cookie holding the sign-in's nonce: the browser that started it must be
 *  the one that comes back. */
export const LINEAR_NONCE_COOKIE = "outrunner_linear_oauth";
export const LINEAR_COOKIE_PATH = "/api/integrations/linear";

/** What the install asks for: to read for triage, to write back, and to be
 *  delegated issues and @mentioned. */
export const LINEAR_INSTALL_SCOPES = ["read", "write", "app:assignable", "app:mentionable"] as const;
/** What linking a person asks for: enough to learn who they are. */
export const LINEAR_LINK_SCOPES = ["read"] as const;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const STATE_TTL_MS = 10 * 60 * 1000;
/** A webhook's answer is due in 5s, and these are asked on its way. */
const REQUEST_TIMEOUT_MS = 3000;
/** How far off a webhook's timestamp may be: Linear's own figure. */
const WEBHOOK_TOLERANCE_MS = 60_000;
/** Each refresh gives a refresh token 30 days. */
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export type LinearConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** What connecting Linear needs from the deployment; null when any is unset. */
export function linearConfig(): LinearConfig | null {
  const clientId = optionalEnv("LINEAR_CLIENT_ID");
  const clientSecret = optionalEnv("LINEAR_CLIENT_SECRET");
  const base = optionalEnv("RUNTIME_BASE_URL");
  if (!clientId || !clientSecret || !base || !optionalEnv("LINEAR_WEBHOOK_SECRET")) return null;
  try {
    return { clientId, clientSecret, redirectUri: new URL(LINEAR_CALLBACK_PATH, base).toString() };
  } catch {
    return null;
  }
}

export type LinearOAuthKind = "install" | "link";

export type LinearOAuthState = {
  kind: LinearOAuthKind;
  /** Who started it: the same person must be signed in on the way back. */
  ownerId: string;
  /** The org an install is for; null for a person's link. */
  orgId: string | null;
  nonce: string;
};

const STATE_KIND = "linear-oauth";

export function signLinearState(state: LinearOAuthState, secret: string, now = Date.now()): string {
  return signPayload(STATE_KIND, { k: state.kind, w: state.ownerId, o: state.orgId, n: state.nonce, exp: now + STATE_TTL_MS }, secret);
}

export function verifyLinearState(token: unknown, secret: string, now = Date.now()): LinearOAuthState | null {
  const data = verifyPayload(STATE_KIND, token, secret, now);
  if (!data) return null;
  const { k, w, o, n } = data;
  if ((k !== "install" && k !== "link") || typeof w !== "string" || typeof n !== "string") return null;
  if (o !== null && typeof o !== "string") return null;
  if (k === "install" && o === null) return null;
  return { kind: k, ownerId: w, orgId: o, nonce: n };
}

/** Linear's page to authorize on: as the app's own user for an install (which
 *  takes a workspace admin), as themselves for a person's link. */
export function linearAuthorizeUrl(config: LinearConfig, kind: LinearOAuthKind, state: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: (kind === "install" ? LINEAR_INSTALL_SCOPES : LINEAR_LINK_SCOPES).join(","),
    state,
    actor: kind === "install" ? "app" : "user",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

/**
 * Whether a webhook's body is Linear's: the hex HMAC-SHA256 of its raw bytes,
 * under the app's webhook signing secret. Over the bytes as they came, never
 * the body parsed and written out again.
 */
export function verifyLinearSignature(body: Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const given = Buffer.from(signature, "hex");
  const wanted = createHmac("sha256", secret).update(body).digest();
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Whether a webhook was sent just now, so a captured one can't be replayed. */
export function isFreshWebhook(timestamp: unknown, now = Date.now()): boolean {
  return typeof timestamp === "number" && Math.abs(now - timestamp) <= WEBHOOK_TOLERANCE_MS;
}

export type LinearTokens = TrackerTokens;
export { TrackerRevokedError as LinearRevokedError, TrackerUnauthorizedError as LinearUnauthorizedError, TrackerUnavailableError as LinearUnavailableError };
/** Linear says what was asked for doesn't exist. */
class LinearNotFoundError extends TrackerRefusedError {}

type Fetcher = typeof fetch;

async function tokenRequest(params: Record<string, string>, config: LinearConfig, fetcher: Fetcher, now: number): Promise<LinearTokens> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new TrackerUnavailableError(`Linear's token endpoint didn't answer: ${String(error)}`);
  });
  const answer = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || typeof answer?.access_token !== "string") {
    if (answer?.error === "invalid_grant") throw new TrackerRevokedError("Linear refused the grant.");
    throw new TrackerUnavailableError(`Linear's token endpoint answered ${response.status}.`);
  }
  const refreshToken = typeof answer.refresh_token === "string" ? answer.refresh_token : null;
  return {
    accessToken: answer.access_token,
    refreshToken,
    expiresAt: new Date(now + (typeof answer.expires_in === "number" ? answer.expires_in : 86_399) * 1000),
    refreshExpiresAt: refreshToken ? new Date(now + REFRESH_TOKEN_LIFETIME_MS) : null,
  };
}

export function exchangeLinearCode(config: LinearConfig, code: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<LinearTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, config, fetcher, now);
}

export function refreshLinearToken(config: LinearConfig, refreshToken: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<LinearTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, config, fetcher, now);
}

/** Give a token back: one a person's link only needed to learn who they are,
 *  or an install's whose last org left. Best effort. */
export async function revokeLinearToken(token: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.warn("Linear: couldn't revoke a token", error);
    return null;
  });
  // The token may have survived: worth knowing about.
  if (response && !response.ok) console.warn(`Linear: revoking a token answered ${response.status}`);
}

async function query<T>(token: string, text: string, variables: Record<string, unknown>, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: text, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new TrackerUnavailableError(`Linear's API didn't answer: ${String(error)}`);
  });
  if (response.status === 401) throw new TrackerUnauthorizedError("Linear refused this token.");
  const answer = (await response.json().catch(() => null)) as { data?: T | null; errors?: { message?: unknown; extensions?: { statusCode?: unknown; code?: unknown } }[] } | null;
  if (answer?.data && response.ok) return answer.data;
  if (answer?.errors?.some((e) => typeof e.message === "string" && /entity not found/i.test(e.message))) {
    throw new LinearNotFoundError("Linear has no such entity.");
  }
  // It says so in the errors of a 200. Being rate limited is a 400 too, and passes.
  if (answer?.errors?.some((e) => [400, 403, 404].includes(e.extensions?.statusCode as number) && e.extensions?.code !== "RATELIMITED")) {
    throw new TrackerRefusedError(`Linear refused this: ${answer.errors.map((e) => e.extensions?.code).join(", ")}.`);
  }
  throw new TrackerUnavailableError(`Linear's API answered ${response.status}.`);
}

/**
 * {@link query} for something that may no longer exist, which Linear answers
 * with GraphQL errors and no data: null, not a failure. A failure would answer
 * the webhook non-200 for an issue that's gone for good, spending Linear's
 * retries on it, and a webhook that keeps failing may be disabled.
 */
async function lookup<T>(token: string, text: string, variables: Record<string, unknown>, fetcher: Fetcher): Promise<T | null> {
  try {
    return await query<T>(token, text, variables, fetcher);
  } catch (error) {
    if (error instanceof LinearNotFoundError) return null;
    throw error;
  }
}

export type LinearViewer = {
  id: string;
  name: string | null;
  /** Whether this is an app's token, not a person's: only that can be an install. */
  app?: boolean;
  organization: { id: string; name: string | null; urlKey: string | null };
};

/** Who a token is: the app's own user for an install's, the person for a link's. */
export async function linearViewer(token: string, fetcher: Fetcher = fetch): Promise<LinearViewer> {
  try {
    const data = await query<{ viewer: LinearViewer }>(token, "query { viewer { id name app organization { id name urlKey } } }", {}, fetcher);
    return data.viewer;
  } catch (error) {
    // Seen in the moment after the app is revoked, before Linear settles on a 401,
    // which it had within 0.3s in one run: the token's own user is gone, and the
    // revocation's event can land right then. A refusal, for a refresh to settle,
    // which Linear refused 0.6s after a revoke.
    if (error instanceof LinearNotFoundError) throw new TrackerUnauthorizedError("Linear no longer has this token's user.");
    throw error;
  }
}

export type LinearTeam = { id: string; key: string; name: string };

export async function linearTeams(token: string, fetcher: Fetcher = fetch): Promise<LinearTeam[]> {
  const data = await query<{ teams: { nodes: LinearTeam[] } }>(token, "query { teams(first: 100) { nodes { id key name } } }", {}, fetcher);
  return data.teams.nodes;
}

export type LinearState = { id: string; name: string; type: string };
export type LinearCatalog = {
  states: LinearState[];
  labels: { id: string; name: string }[];
  members: { id: string; name: string }[];
};

/** What a team's rules pick from: its states, its labels and the workspace's,
 *  and its people. */
export async function linearTeamCatalog(token: string, teamId: string, fetcher: Fetcher = fetch): Promise<LinearCatalog | null> {
  const data = await lookup<{
    team: {
      states: { nodes: LinearState[] };
      labels: { nodes: { id: string; name: string }[] };
      members: { nodes: { id: string; displayName: string | null; name: string }[] };
    } | null;
    issueLabels: { nodes: { id: string; name: string }[] };
  }>(
    token,
    `query($id: String!) {
      team(id: $id) {
        states(first: 50) { nodes { id name type } }
        labels(first: 100) { nodes { id name } }
        members(first: 200) { nodes { id name displayName } }
      }
      issueLabels(first: 100, filter: { team: { null: true } }) { nodes { id name } }
    }`,
    { id: teamId },
    fetcher,
  );
  if (!data?.team) return null;
  return {
    states: data.team.states.nodes,
    labels: [...data.team.labels.nodes, ...data.issueLabels.nodes],
    members: data.team.members.nodes.map((m) => ({ id: m.id, name: m.displayName || m.name })),
  };
}

/** What a comment's or a delegation's webhook doesn't say about its issue: whose
 *  team it's in now, and its state. Null for an issue Linear no longer shows. */
export async function linearIssueStanding(
  token: string,
  issueId: string,
  fetcher: Fetcher = fetch,
): Promise<{ teamId: string; open: boolean; stateType: string | null; delegateId: string | null } | null> {
  const data = await lookup<{ issue: { trashed: boolean | null; team: { id: string } | null; state: { type: string } | null; delegate: { id: string } | null } | null }>(
    token,
    "query($id: String!) { issue(id: $id) { trashed team { id } state { type } delegate { id } } }",
    { id: issueId },
    fetcher,
  );
  const issue = data?.issue;
  if (!issue?.team) return null;
  return {
    teamId: issue.team.id,
    open: Boolean(!issue.trashed && issue.state && !isClosedStateType(issue.state.type)),
    stateType: issue.state?.type ?? null,
    delegateId: issue.delegate?.id ?? null,
  };
}

/** Who wrote an issue: a webhook only says on some events. Null for no person
 *  (an integration made it). */
export async function linearIssueCreator(token: string, issueId: string, fetcher: Fetcher = fetch): Promise<{ id: string; name: string | null } | null> {
  const data = await lookup<{ issue: { creator: { id: string; name: string | null; displayName?: string | null } | null } | null }>(
    token,
    "query($id: String!) { issue(id: $id) { creator { id name displayName } } }",
    { id: issueId },
    fetcher,
  );
  const creator = data?.issue?.creator;
  return creator ? { id: creator.id, name: creator.displayName || creator.name } : null;
}

/** The issue this one was marked a duplicate of, if any: a duplicate's or a
 *  canceled issue's webhook doesn't say. It's in the duplicate's own relations. */
export async function linearDuplicateOf(token: string, issueId: string, fetcher: Fetcher = fetch): Promise<string | null> {
  const data = await lookup<{ issue: { relations: { nodes: { type: string; relatedIssue: { id: string } | null }[] } } | null }>(
    token,
    "query($id: String!) { issue(id: $id) { relations(first: 50) { nodes { type relatedIssue { id } } } } }",
    { id: issueId },
    fetcher,
  );
  return data?.issue?.relations.nodes.find((r) => r.type === "duplicate")?.relatedIssue?.id ?? null;
}

// --- Writing back -------------------------------------------------------------

export type LinearActivity =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export type LinearSignal =
  | { signal: "auth"; signalMetadata: { url: string; userId?: string; providerName?: string } }
  | { signal: "select"; signalMetadata: { options: { label: string; value: string }[] } };

/** Say something in an agent session. */
export async function linearAgentActivity(
  token: string,
  agentSessionId: string,
  content: LinearActivity,
  signal?: LinearSignal,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await query(
    token,
    "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
    { input: { agentSessionId, content, ...signal } },
    fetcher,
  );
}

/** Add a link to an agent session: where the work is, and its PR. */
export async function linearAddSessionUrl(token: string, agentSessionId: string, url: { label: string; url: string }, fetcher: Fetcher = fetch): Promise<void> {
  await query(
    token,
    "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
    { id: agentSessionId, input: { addedExternalUrls: [url] } },
    fetcher,
  );
}

export async function linearComment(token: string, issueId: string, body: string, fetcher: Fetcher = fetch): Promise<void> {
  await query(token, "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId, body } }, fetcher);
}

export async function linearSetIssueState(token: string, issueId: string, stateId: string, fetcher: Fetcher = fetch): Promise<void> {
  await query(
    token,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id: issueId, input: { stateId } },
    fetcher,
  );
}

/** Link something to an issue. The same URL again changes nothing. */
export async function linearAttachLink(token: string, issueId: string, url: string, title: string, fetcher: Fetcher = fetch): Promise<void> {
  await query(
    token,
    "mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }",
    { issueId, url, title },
    fetcher,
  );
}

export type RepositorySuggestion = { repositoryFullName: string; confidence: number };

/** Which of these repositories Linear thinks an issue is about. */
export async function linearRepositorySuggestions(
  token: string,
  issueId: string,
  agentSessionId: string,
  repositories: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<RepositorySuggestion[]> {
  const data = await lookup<{ issueRepositorySuggestions: { suggestions: RepositorySuggestion[] } }>(
    token,
    `query($issueId: String!, $agentSessionId: String!, $candidates: [CandidateRepository!]!) {
      issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidates) {
        suggestions { repositoryFullName confidence }
      }
    }`,
    { issueId, agentSessionId, candidates: repositories.map((repositoryFullName) => ({ hostname: "github.com", repositoryFullName })) },
    fetcher,
  );
  return data?.issueRepositorySuggestions.suggestions ?? [];
}

/** Our own event: made by the app's user, which is how Linear names the actor for
 *  an install's token, on comments and issues alike. What we write there never
 *  comes back to us. */
export function isOwnLinearEvent(
  payload: { type?: unknown; actor?: { id?: unknown } | null; data?: { userId?: unknown } | null },
  appUserId: string | null,
): boolean {
  const mine = (id: unknown) => typeof id === "string" && id === appUserId;
  return mine(payload.actor?.id) || (payload.type === "Comment" && mine(payload.data?.userId));
}
