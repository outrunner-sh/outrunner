/**
 * The Outrunner GitHub App: an org's admin installs it on their GitHub
 * account or organization, and Outrunner reaches that installation's
 * repositories with short-lived tokens of its own rather than each member's
 * sign-in (docs: Settings → Org → GitHub).
 *
 * Configured by four environment variables (lib/env.ts), all or none:
 * GITHUB_APP_CLIENT_ID (the JWT's issuer, as GitHub now recommends over the
 * App ID), GITHUB_APP_SLUG (its install link), GITHUB_APP_PRIVATE_KEY (the
 * .pem, as it is or base64) and GITHUB_APP_WEBHOOK_SECRET.
 *
 * The rules (signing, verifying, the install link's state) are pure, for
 * tests; the GitHub calls take their fetch, for the same reason.
 */

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

import { optionalEnv } from "@/lib/env";

export type GitHubAppConfig = {
  clientId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
};

/** The App's configuration, or null when it isn't set up on this deployment. */
export function githubAppConfig(): GitHubAppConfig | null {
  const clientId = optionalEnv("GITHUB_APP_CLIENT_ID");
  const slug = optionalEnv("GITHUB_APP_SLUG");
  const key = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = optionalEnv("GITHUB_APP_WEBHOOK_SECRET");
  if (!clientId || !slug || !key || !webhookSecret) return null;
  return { clientId, slug, privateKey: pemFrom(key), webhookSecret };
}

/** The private key as PEM: given as the .pem's text, or that text base64'd
 *  (a value with no newlines survives every secret store). */
export function pemFrom(value: string): string {
  const text = value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  // A store that kept "\n" as two characters.
  return text.replace(/\\n/g, "\n").trim() + "\n";
}

/** A JWT the App authenticates to GitHub with, good for 9 minutes (GitHub
 *  takes at most 10), dated a minute back for clock drift. */
export function appJwt(clientId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: clientId,
  })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

/** Whether a webhook's `X-Hub-Signature-256` is GitHub's, over the raw body,
 *  compared in constant time. */
export function webhookSignatureMatches(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** How long an install link works: long enough to pick repositories. */
const INSTALL_STATE_SECONDS = 30 * 60;

/** What an install link carries back to the setup route: which org the admin
 *  installed for, and who they were. */
export type InstallState = { orgId: string; userId: string };

/** The `state` an install link carries, signed so the setup route knows the
 *  org and the admin are the ones it sent. */
export function signInstallState(secret: string, state: InstallState, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(
    JSON.stringify({ o: state.orgId, u: state.userId, e: nowSeconds + INSTALL_STATE_SECONDS }),
  ).toString("base64url");
  return `${payload}.${installStateMac(secret, payload)}`;
}

/** The state an install link carried, or null for one that isn't ours, was
 *  changed, or has expired. */
export function readInstallState(
  secret: string,
  value: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): InstallState | null {
  const [payload, mac] = value?.split(".") ?? [];
  if (!payload || !mac) return null;
  const expected = Buffer.from(installStateMac(secret, payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { o, u, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      o?: unknown;
      u?: unknown;
      e?: unknown;
    };
    if (typeof o !== "string" || typeof u !== "string" || typeof e !== "number" || e < nowSeconds) return null;
    return { orgId: o, userId: u };
  } catch {
    return null;
  }
}

function installStateMac(secret: string, payload: string): string {
  // Its own purpose, apart from verifying webhooks with the same secret.
  return createHmac("sha256", secret).update(`install-state:${payload}`).digest("base64url");
}

/** Where an org's admin installs the App, for their GitHub account or
 *  organization and the repositories they pick. */
export function installUrl(slug: string, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

// ---------------------------------------------------------------------------
// GitHub's API, as the App.
// ---------------------------------------------------------------------------

const API = "https://api.github.com";

type Fetch = typeof fetch;

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "outrunner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** GitHub refused or failed a call the App made; never carries a token. */
export class GitHubAppError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}

async function call<T>(doFetch: Fetch, url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await doFetch(url, {
    method: init.method ?? "GET",
    headers: { ...headers(token), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new GitHubAppError(`GitHub answered ${response.status} to ${init.method ?? "GET"} ${new URL(url).pathname}`, response.status);
  }
  return (await response.json()) as T;
}

/** An installation, as Outrunner keeps it. */
export type Installation = {
  id: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  /** When GitHub suspended it, if it's suspended. */
  suspendedAt: string | null;
};

type ApiInstallation = {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: string;
  suspended_at: string | null;
};

/** An installation as GitHub sends it (the API, or a webhook), or null for
 *  one with no account: there's nothing to keep it under. */
export function toInstallation(i: Partial<ApiInstallation> & { id?: number }): Installation | null {
  if (typeof i.id !== "number" || !i.account?.login) return null;
  return {
    id: i.id,
    accountLogin: i.account.login,
    accountType: i.account.type === "Organization" ? "Organization" : "User",
    repositorySelection: i.repository_selection === "selected" ? "selected" : "all",
    suspendedAt: i.suspended_at ?? null,
  };
}

/** An installation of the App, asked as the App; null when GitHub has none by
 *  that id (uninstalled, or another App's), or it has no account. */
export async function getInstallation(
  config: GitHubAppConfig,
  installationId: number,
  doFetch: Fetch = fetch,
): Promise<Installation | null> {
  try {
    return toInstallation(
      await call<ApiInstallation>(doFetch, `${API}/app/installations/${installationId}`, appJwt(config.clientId, config.privateKey)),
    );
  } catch (error) {
    if (error instanceof GitHubAppError && error.status === 404) return null;
    throw error;
  }
}

/** A token an installation's repositories are reached with: an hour long,
 *  and only for `repositories` (names, not owner/name) when given. */
export type InstallationToken = { token: string; expiresAt: Date };

/** Installation tokens, kept until 5 minutes before they expire: GitHub
 *  limits how often they're made. Per installation, for all its repositories. */
const tokens = new Map<number, InstallationToken>();
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** A token for all an installation's repositories, made once and kept. */
export async function installationToken(
  config: GitHubAppConfig,
  installationId: number,
  doFetch: Fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const kept = tokens.get(installationId);
  if (kept && kept.expiresAt.getTime() - TOKEN_MARGIN_MS > now) return kept.token;
  const minted = await mintInstallationToken(config, installationId, undefined, doFetch);
  tokens.set(installationId, minted);
  return minted.token;
}

/** Forget an installation's kept token (it was uninstalled or suspended). */
export function dropInstallationToken(installationId: number): void {
  tokens.delete(installationId);
}

/** What a token may do, narrower than the App's own permissions; all of
 *  them when absent. */
export type TokenPermissions = Partial<
  Record<"contents" | "pull_requests" | "metadata" | "checks" | "statuses" | "workflows", "read" | "write">
>;

/** What an installation was granted, by permission ("read", "write"); its
 *  owner may have accepted fewer than the App asks for. */
export async function installationPermissions(
  config: GitHubAppConfig,
  installationId: number,
  doFetch: Fetch = fetch,
): Promise<Record<string, string>> {
  const installation = await call<{ permissions?: Record<string, string> }>(
    doFetch,
    `${API}/app/installations/${installationId}`,
    appJwt(config.clientId, config.privateKey),
  );
  return installation.permissions ?? {};
}

export async function mintInstallationToken(
  config: GitHubAppConfig,
  installationId: number,
  repositories?: string[],
  doFetch: Fetch = fetch,
  permissions?: TokenPermissions,
): Promise<InstallationToken> {
  const minted = await call<{ token: string; expires_at: string }>(
    doFetch,
    `${API}/app/installations/${installationId}/access_tokens`,
    appJwt(config.clientId, config.privateKey),
    {
      method: "POST",
      body: { ...(repositories?.length && { repositories }), ...(permissions && { permissions }) },
    },
  );
  return { token: minted.token, expiresAt: new Date(minted.expires_at) };
}

/** A pull request as GitHub's API gives it, read as the installation. */
export async function getPullRequest(
  token: string,
  repoFullName: string,
  number: number,
  doFetch: Fetch = fetch,
): Promise<Record<string, unknown>> {
  return call(doFetch, `${API}/repos/${repoFullName}/pulls/${number}`, token);
}

/** GitHub has no such installation any more: uninstalled, its webhook
 *  missed or not yet handled. */
export class InstallationGoneError extends Error {
  constructor() {
    super("The GitHub App's installation is gone.");
    this.name = "InstallationGoneError";
  }
}

/** GitHub refuses the installation a token because it's suspended (its
 *  webhook missed or not yet handled): since when, as GitHub has it. */
export class InstallationSuspendedError extends Error {
  readonly installationId: number;
  readonly suspendedAt: string;

  constructor(installationId: number, suspendedAt: string) {
    super("The GitHub App's installation is suspended.");
    this.name = "InstallationSuspendedError";
    this.installationId = installationId;
    this.suspendedAt = suspendedAt;
  }
}

/**
 * A pull request, read as the installation. A kept token GitHub refuses
 * (401) is dropped and one minted afresh, once: only if that's refused too,
 * or none can be minted (404), is the installation gone. One GitHub won't
 * mint for (403) is suspended if GitHub says so; else it was only refused
 * for now (a rate limit), and that's thrown as it is.
 */
export async function installationPullRequest(
  config: GitHubAppConfig,
  installationId: number,
  repoFullName: string,
  number: number,
  doFetch: Fetch = fetch,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    let token: string;
    try {
      token = await installationToken(config, installationId, doFetch);
    } catch (error) {
      if (error instanceof GitHubAppError && error.status === 404) throw new InstallationGoneError();
      // Suspended, or only rate limited (GitHub answers 403 to both): the
      // installation itself says which.
      if (error instanceof GitHubAppError && error.status === 403) {
        const installation = await getInstallation(config, installationId, doFetch).catch(() => null);
        if (installation?.suspendedAt) throw new InstallationSuspendedError(installationId, installation.suspendedAt);
      }
      throw error;
    }
    try {
      return await getPullRequest(token, repoFullName, number, doFetch);
    } catch (error) {
      if (!(error instanceof GitHubAppError && error.status === 401)) throw error;
      dropInstallationToken(installationId);
      if (attempt > 0) throw new InstallationGoneError();
    }
  }
}

/** A repository an installation reaches. */
export type InstallationRepository = {
  githubRepoId: number;
  fullName: string;
  private: boolean;
};

/** The repositories an installation reaches, up to `limit` (1,000 at most,
 *  10 pages), and how many it reaches in all: a `limit` of 100 or fewer is
 *  one request. */
export async function listInstallationRepositories(
  token: string,
  { limit = 1000 }: { limit?: number } = {},
  doFetch: Fetch = fetch,
): Promise<{ repositories: InstallationRepository[]; total: number }> {
  const perPage = Math.min(100, Math.max(1, limit));
  const repositories: InstallationRepository[] = [];
  let total = 0;
  for (let page = 1; page <= 10 && repositories.length < limit; page++) {
    const data = await call<{
      total_count: number;
      repositories: Array<{ id: number; full_name: string; private: boolean }>;
    }>(doFetch, `${API}/installation/repositories?per_page=${perPage}&page=${page}`, token);
    total = data.total_count;
    repositories.push(...data.repositories.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private })));
    if (data.repositories.length < perPage) break;
  }
  return { repositories: repositories.slice(0, limit), total };
}
