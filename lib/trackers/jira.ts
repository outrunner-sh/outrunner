/**
 * Jira Cloud's side of a connection: its OAuth (3LO), its webhook's token, and its
 * REST API. docs/jira-app.md sets the app up. The install authorizes as a dedicated
 * service account, so what's written, and the webhook, belong to that account and
 * outlive any member.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { optionalEnv } from "@/lib/env";
import { signPayload, verifyPayload } from "@/lib/slack/slack";
import { toAdf } from "@/lib/trackers/jira-adf";
import { TrackerRevokedError, type TrackerTokens, TrackerUnauthorizedError, TrackerUnavailableError, TrackerRefusedError } from "@/lib/trackers/errors";

export const JIRA_CALLBACK_PATH = "/api/integrations/jira/callback";
export const JIRA_NONCE_COOKIE = "outrunner_jira_oauth";
export const JIRA_COOKIE_PATH = "/api/integrations/jira";
export const JIRA_WEBHOOK_PATH = "/api/integrations/jira/webhook";

export const JIRA_INSTALL_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook", "read:me", "offline_access"] as const;
export const JIRA_LINK_SCOPES = ["read:me", "read:jira-user"] as const;
/** Enough to ask Jira whether whoever signed in administers the site, and no more. */
export const JIRA_RECLAIM_SCOPES = ["read:me", "read:jira-work"] as const;

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const API = "https://api.atlassian.com";
const STATE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
/** Rotating refresh tokens last 90 days idle: each refresh gives another 90. */
export const REFRESH_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export type JiraConfig = { clientId: string; clientSecret: string; redirectUri: string; webhookUrl: string };

export function jiraConfig(): JiraConfig | null {
  const clientId = optionalEnv("JIRA_CLIENT_ID");
  const clientSecret = optionalEnv("JIRA_CLIENT_SECRET");
  const base = optionalEnv("RUNTIME_BASE_URL");
  if (!clientId || !clientSecret || !base) return null;
  try {
    return { clientId, clientSecret, redirectUri: new URL(JIRA_CALLBACK_PATH, base).toString(), webhookUrl: new URL(JIRA_WEBHOOK_PATH, base).toString() };
  } catch {
    return null;
  }
}

export type JiraOAuthKind = "install" | "link" | "reclaim";
export type JiraOAuthState = {
  kind: JiraOAuthKind;
  ownerId: string;
  orgId: string | null;
  nonce: string;
  /** The site being reclaimed. */
  siteId?: string;
};

const STATE_KIND = "jira-oauth";

export function signJiraState(state: JiraOAuthState, secret: string, now = Date.now()): string {
  return signPayload(STATE_KIND, { k: state.kind, w: state.ownerId, o: state.orgId, n: state.nonce, s: state.siteId ?? null, exp: now + STATE_TTL_MS }, secret);
}

export function verifyJiraState(token: unknown, secret: string, now = Date.now()): JiraOAuthState | null {
  const data = verifyPayload(STATE_KIND, token, secret, now);
  if (!data) return null;
  const { k, w, o, n, s } = data;
  if ((k !== "install" && k !== "link" && k !== "reclaim") || typeof w !== "string" || typeof n !== "string") return null;
  if (o !== null && typeof o !== "string") return null;
  if ((k === "install" || k === "reclaim") && o === null) return null;
  if (k === "reclaim" && (typeof s !== "string" || !s)) return null;
  return { kind: k, ownerId: w, orgId: o, nonce: n, ...(k === "reclaim" && { siteId: s as string }) };
}

export function jiraAuthorizeUrl(config: JiraConfig, kind: JiraOAuthKind, state: string): string {
  const query = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.clientId,
    scope: (kind === "install" ? JIRA_INSTALL_SCOPES : kind === "reclaim" ? JIRA_RECLAIM_SCOPES : JIRA_LINK_SCOPES).join(" "),
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

function base64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Whether a webhook is Jira's: a dynamic webhook carries a JWT in Authorization, signed with
 * the app's client secret. As seen on real deliveries: HS256, with `exp` 15 minutes after `iat`,
 * so one without an `exp` isn't Jira's. The body isn't covered, so a captured token could carry
 * another one until then: Jira gives no signature over the body for these.
 */
export function verifyJiraWebhookToken(authorization: string | null, clientSecret: string, now = Date.now()): boolean {
  if (!clientSecret || !authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [head, body, signature] = parts as [string, string, string];
  let header: { alg?: unknown } | null;
  let claims: { exp?: unknown } | null;
  try {
    header = JSON.parse(base64url(head).toString("utf8")) as { alg?: unknown };
    claims = JSON.parse(base64url(body).toString("utf8")) as { exp?: unknown };
  } catch {
    return false;
  }
  // Only HS256: no token can choose how it's checked.
  if (header?.alg !== "HS256") return false;
  const wanted = createHmac("sha256", clientSecret).update(`${head}.${body}`).digest();
  const given = base64url(signature);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return false;
  return typeof claims?.exp === "number" && claims.exp * 1000 > now;
}

type Fetcher = typeof fetch;

async function tokenRequest(params: Record<string, string>, config: JiraConfig, fetcher: Fetcher, now: number): Promise<TrackerTokens> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, client_id: config.clientId, client_secret: config.clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new TrackerUnavailableError(`Atlassian's token endpoint didn't answer: ${String(error)}`);
  });
  const answer = (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (!response.ok || typeof answer?.access_token !== "string") {
    if (answer?.error === "invalid_grant" || answer?.error === "unauthorized_client") throw new TrackerRevokedError("Atlassian refused the grant.");
    throw new TrackerUnavailableError(`Atlassian's token endpoint answered ${response.status}.`);
  }
  const refreshToken = typeof answer.refresh_token === "string" ? answer.refresh_token : null;
  return {
    accessToken: answer.access_token,
    refreshToken,
    expiresAt: new Date(now + (typeof answer.expires_in === "number" ? answer.expires_in : 3600) * 1000),
    refreshExpiresAt: refreshToken ? new Date(now + REFRESH_TOKEN_IDLE_MS) : null,
  };
}

export function exchangeJiraCode(config: JiraConfig, code: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<TrackerTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, config, fetcher, now);
}

export function refreshJiraToken(config: JiraConfig, refreshToken: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<TrackerTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, config, fetcher, now);
}

async function request<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}, fetcher: Fetcher = fetch): Promise<T | null> {
  const response = await fetcher(url, {
    method: init.method ?? "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new TrackerUnavailableError(`Jira's API didn't answer: ${String(error)}`);
  });
  if (response.status === 401) throw new TrackerUnauthorizedError("Jira refused this token.");
  if (response.status === 404) return null;
  if (response.status === 400 || response.status === 403) throw new TrackerRefusedError(`Jira refused this: ${response.status}.`);
  if (!response.ok) throw new TrackerUnavailableError(`Jira's API answered ${response.status}.`);
  if (response.status === 204) return null;
  return (await response.json().catch(() => null)) as T | null;
}

const site = (cloudId: string) => `${API}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;

export type JiraSite = { id: string; name: string; url: string };

/** The sites a token can reach. */
export async function jiraSites(token: string, fetcher: Fetcher = fetch): Promise<JiraSite[]> {
  return (await request<JiraSite[]>(token, `${API}/oauth/token/accessible-resources`, {}, fetcher)) ?? [];
}

/** Who a token is. */
export async function jiraMe(token: string, fetcher: Fetcher = fetch): Promise<{ accountId: string; name: string | null } | null> {
  const me = await request<{ account_id?: string; name?: string }>(token, `${API}/me`, {}, fetcher);
  return me?.account_id ? { accountId: me.account_id, name: me.name ?? null } : null;
}

export { toAdf };

/** Whether this token's person administers the site, by Jira's global permission. */
export async function jiraIsSiteAdmin(token: string, cloudId: string, fetcher: Fetcher = fetch): Promise<boolean> {
  const answer = await request<{ permissions?: { ADMINISTER?: { havePermission?: unknown } } }>(token, `${site(cloudId)}/mypermissions?permissions=ADMINISTER`, {}, fetcher);
  return answer?.permissions?.ADMINISTER?.havePermission === true;
}

export type JiraProject = { id: string; key: string; name: string };

export async function jiraProjects(token: string, cloudId: string, fetcher: Fetcher = fetch): Promise<JiraProject[]> {
  const projects: JiraProject[] = [];
  // Bounded, as a site's answer decides how long this goes on.
  for (let pages = 0; pages < 100; pages++) {
    const page = await request<{ values?: JiraProject[]; isLast?: boolean }>(token, `${site(cloudId)}/project/search?startAt=${projects.length}&maxResults=100`, {}, fetcher);
    const values = page?.values ?? [];
    projects.push(...values.map((p) => ({ id: p.id, key: p.key, name: p.name })));
    if (page?.isLast === true || values.length === 0) break;
  }
  return projects;
}

/** A status's category, in the words Linear's state types use, which the state map, the
 *  settings page and the rules already read: `done` is closed, whatever it's called. */
export function jiraStateType(category: unknown): string {
  return category === "done" ? "completed" : category === "indeterminate" ? "started" : "unstarted";
}

export type JiraCatalog = {
  states: { id: string; name: string; type: string }[];
  labels: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  issueTypes: { id: string; name: string }[];
  members: { id: string; name: string }[];
};

/** What a project's rules pick from. */
export async function jiraProjectCatalog(token: string, cloudId: string, projectId: string, fetcher: Fetcher = fetch): Promise<JiraCatalog | null> {
  const encoded = encodeURIComponent(projectId);
  const types = await request<{ id: string; name: string; statuses?: { id: string; name: string; statusCategory?: { key?: string } }[] }[]>(token, `${site(cloudId)}/project/${encoded}/statuses`, {}, fetcher);
  if (!types) return null;
  const [labels, priorities, users] = await Promise.all([
    request<{ values?: string[] }>(token, `${site(cloudId)}/label?maxResults=200`, {}, fetcher),
    request<{ id: string; name: string }[]>(token, `${site(cloudId)}/priority`, {}, fetcher),
    request<{ accountId: string; displayName?: string }[]>(token, `${site(cloudId)}/user/assignable/search?project=${encoded}&maxResults=200`, {}, fetcher),
  ]);
  const states = new Map<string, { id: string; name: string; type: string }>();
  for (const type of types) {
    for (const status of type.statuses ?? []) states.set(status.id, { id: status.id, name: status.name, type: jiraStateType(status.statusCategory?.key) });
  }
  return {
    states: [...states.values()],
    labels: (labels?.values ?? []).map((name) => ({ id: name, name })),
    priorities: (priorities ?? []).map((p) => ({ id: p.id, name: p.name })),
    issueTypes: types.map((t) => ({ id: t.id, name: t.name })),
    members: (users ?? []).map((u) => ({ id: u.accountId, name: u.displayName ?? u.accountId })),
  };
}

/** The JQL a site's one webhook filters on: every connected project, so assigns and
 *  @mentions arrive where no rule exists. Rules are checked on our side. */
export function jiraWebhookJql(projectIds: readonly string[]): string {
  // Ids are numbers. Nothing else goes into the query.
  return `project in (${projectIds.filter((id) => /^\d+$/.test(id)).join(", ")})`;
}

const WEBHOOK_EVENTS = ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"];

export async function jiraRegisterWebhook(token: string, cloudId: string, url: string, projectIds: readonly string[], fetcher: Fetcher = fetch): Promise<number | null> {
  const answer = await request<{ webhookRegistrationResult?: { createdWebhookId?: number; errors?: string[] }[] }>(
    token,
    `${site(cloudId)}/webhook`,
    { method: "POST", body: { url, webhooks: [{ events: WEBHOOK_EVENTS, jqlFilter: jiraWebhookJql(projectIds) }] } },
    fetcher,
  );
  const result = answer?.webhookRegistrationResult?.[0];
  if (!result?.createdWebhookId) throw new TrackerUnavailableError(`Jira refused the webhook: ${(result?.errors ?? []).join("; ") || "no reason given"}`);
  return result.createdWebhookId;
}

export async function jiraDeleteWebhook(token: string, cloudId: string, webhookId: number, fetcher: Fetcher = fetch): Promise<void> {
  await request(token, `${site(cloudId)}/webhook`, { method: "DELETE", body: { webhookIds: [webhookId] } }, fetcher);
}

/**
 * Webhooks expire after 30 days. When this one now does, or null if Jira didn't say or no longer
 * has it. A refresh can't tell: it answers with a date for an id that doesn't exist, as seen on a
 * real site, so a removed webhook would look fine for ever. So the list is asked too.
 */
export async function jiraRefreshWebhook(token: string, cloudId: string, webhookId: number, fetcher: Fetcher = fetch): Promise<Date | null> {
  const answer = await request<{ expirationDate?: string }>(token, `${site(cloudId)}/webhook/refresh`, { method: "PUT", body: { webhookIds: [webhookId] } }, fetcher);
  const at = answer?.expirationDate ? Date.parse(answer.expirationDate) : NaN;
  if (!Number.isFinite(at)) return null;
  // A read that fails throws, so it's never taken for missing. Nor is an answer that isn't a
  // list. Only a whole list without it says it's gone, or a site could fill up with duplicates.
  let startAt = 0;
  for (let pages = 0; pages < 100; pages++) {
    const page = await request<{ values?: { id?: number }[]; isLast?: boolean }>(token, `${site(cloudId)}/webhook?startAt=${startAt}&maxResults=100`, {}, fetcher);
    if (!Array.isArray(page?.values)) return new Date(at);
    if (page.values.some((webhook) => webhook.id === webhookId)) return new Date(at);
    if (page.isLast !== false || page.values.length === 0) return null;
    startAt += page.values.length;
  }
  return new Date(at);
}

/** How wiki markup writes a mention: webhooks may send a body that way, not as a document. */
const WIKI_MENTION = /\[~accountid:[^\]\s]+\]/g;

/** A description or comment as plain text, from a document or a wiki-markup string:
 *  Atlassian's page doesn't say which a webhook sends. */
export function fromAdf(node: unknown): string {
  if (typeof node === "string") return node.replace(WIKI_MENTION, "@someone");
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: unknown; text?: unknown; content?: unknown; attrs?: { text?: unknown } };
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "mention" && typeof value.attrs?.text === "string") return value.attrs.text;
  if (value.type === "hardBreak") return "\n";
  const inner = Array.isArray(value.content) ? value.content : [];
  const blocks = new Set(["doc", "bulletList", "orderedList", "listItem", "blockquote", "panel"]);
  if (blocks.has(String(value.type))) return inner.map(fromAdf).filter(Boolean).join("\n");
  return inner.map(fromAdf).join("");
}

/** Whether a description or comment @mentions this account. */
export function jiraMentions(node: unknown, accountId: string): boolean {
  if (typeof node === "string") return node.includes(`[~accountid:${accountId}]`);
  if (!node || typeof node !== "object") return false;
  const value = node as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
  if (value.type === "mention" && value.attrs?.id === accountId) return true;
  return Array.isArray(value.content) && value.content.some((child) => jiraMentions(child, accountId));
}

/** Internal, where that means anything: on a service project a plain comment reaches the
 *  customer's portal, and ours can list repositories. Elsewhere the property does nothing. */
export const JIRA_INTERNAL_COMMENT = [{ key: "sd.public.comment", value: { internal: true } }];

export async function jiraComment(token: string, cloudId: string, issueId: string, text: string, fetcher: Fetcher = fetch): Promise<void> {
  await request(token, `${site(cloudId)}/issue/${encodeURIComponent(issueId)}/comment`, { method: "POST", body: { body: toAdf(text), properties: JIRA_INTERNAL_COMMENT } }, fetcher);
}

/** Link something to an issue. The same globalId again updates it, rather than adding another. */
export async function jiraRemoteLink(token: string, cloudId: string, issueId: string, url: string, title: string, fetcher: Fetcher = fetch): Promise<void> {
  await request(token, `${site(cloudId)}/issue/${encodeURIComponent(issueId)}/remotelink`, { method: "POST", body: { globalId: url, object: { url, title } } }, fetcher);
}

export type JiraIssueStanding = {
  teamId: string;
  key: string | null;
  title: string;
  description: string;
  open: boolean;
  /** As {@link jiraStateType}. */
  stateType: string;
  /** Only a person: a bot's issue has no one to run its session as. */
  creatorId: string | null;
  creatorName: string | null;
  duplicateOf: string | null;
  assigneeId: string | null;
};

type IssueLink = { type?: { name?: string }; outwardIssue?: { id?: string } };

/** What an event may not say about an issue. Null for one Jira no longer has. */
export async function jiraIssueStanding(token: string, cloudId: string, issueId: string, fetcher: Fetcher = fetch): Promise<JiraIssueStanding | null> {
  const issue = await request<{
    key?: string;
    fields?: {
      summary?: string;
      description?: unknown;
      project?: { id?: string };
      status?: { id?: string; statusCategory?: { key?: string } };
      creator?: { accountId?: string; displayName?: string; accountType?: string };
      issuelinks?: IssueLink[];
      assignee?: { accountId?: string } | null;
    };
  }>(token, `${site(cloudId)}/issue/${encodeURIComponent(issueId)}?fields=summary,description,project,status,creator,issuelinks,assignee`, {}, fetcher);
  const fields = issue?.fields;
  if (!fields?.project?.id) return null;
  const stateType = jiraStateType(fields.status?.statusCategory?.key);
  const person = fields.creator?.accountType === "atlassian";
  return {
    teamId: fields.project.id,
    key: issue?.key ?? null,
    title: fields.summary ?? "Untitled issue",
    description: fromAdf(fields.description),
    open: stateType !== "completed",
    stateType,
    creatorId: person ? (fields.creator?.accountId ?? null) : null,
    creatorName: person ? (fields.creator?.displayName ?? null) : null,
    assigneeId: fields.assignee?.accountId ?? null,
    duplicateOf: (fields.issuelinks ?? []).find((link) => link.type?.name === "Duplicate" && link.outwardIssue?.id)?.outwardIssue?.id ?? null,
  };
}

/** Move an issue to a status, if a transition there is open to it now. Whether it moved. */
export async function jiraTransition(token: string, cloudId: string, issueId: string, statusId: string, fetcher: Fetcher = fetch): Promise<boolean> {
  const url = `${site(cloudId)}/issue/${encodeURIComponent(issueId)}/transitions`;
  const answer = await request<{ transitions?: { id: string; to?: { id?: string } }[] }>(token, url, {}, fetcher);
  const transition = answer?.transitions?.find((t) => t.to?.id === statusId);
  if (!transition) return false;
  await request(token, url, { method: "POST", body: { transition: { id: transition.id } } }, fetcher);
  return true;
}

/** What a status is, in {@link jiraStateType}'s words: a changelog gives only its id. Null
 *  for one Jira no longer has. */
export async function jiraStatusType(token: string, cloudId: string, statusId: string, fetcher: Fetcher = fetch): Promise<string | null> {
  const status = await request<{ statusCategory?: { key?: string } }>(token, `${site(cloudId)}/status/${encodeURIComponent(statusId)}`, {}, fetcher);
  return status ? jiraStateType(status.statusCategory?.key) : null;
}
