/**
 * A user's own GitHub access, as the Outrunner GitHub App's user
 * authorization (Settings → Connections → GitHub): the App acts on GitHub as
 * the user, so pushes, pull requests and merges show as them, but only where
 * both the user and the App's installations reach (the repositories picked on
 * GitHub when it was installed, all or selected), and only with the App's
 * permissions. Signing in to Outrunner with GitHub is identity alone and grants
 * none of this.
 *
 * Its access token (`ghu_`) lasts 8 hours and a refresh token (6 months)
 * renews it, when the App has "Expire user authorization tokens" on
 * (docs/github-app.md). Both are kept sealed (lib/db/github-connections.ts) and
 * renewed as they're used (lib/github/user-connection.ts).
 *
 * Needs GITHUB_APP_CLIENT_SECRET, and the App's Callback URLs to include
 * `<app>/api/github/user/callback` (and the desktop shell's loopback,
 * `http://127.0.0.1:47823`).
 *
 * The rules (the link's state, PKCE, expiry) are pure, for tests; the GitHub
 * calls take their fetch, for the same reason.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { GitHubAppConfig, Installation } from "@/lib/github/app";
import { toInstallation } from "@/lib/github/app";

type Fetch = typeof fetch;

/** Where the desktop shell listens for an OAuth redirect (signin-button.tsx
 *  DESKTOP_OAUTH_REDIRECT, runtime-desktop's OAUTH_PORT). It hands the query
 *  to the webview's /auth/callback, which forwards one of ours here. */
export const DESKTOP_LOOPBACK_REDIRECT = "http://127.0.0.1:47823";

/** The path GitHub comes back to in a browser. */
export const USER_CALLBACK_PATH = "/api/github/user/callback";

/** Where connecting may come back to; Settings → Connections otherwise. */
export type ConnectReturn = "/settings/connections" | "/onboarding";
export const isConnectReturn = (value: unknown): value is ConnectReturn =>
  value === "/settings/connections" || value === "/onboarding";

/** How long a connect link works: long enough to sign in to GitHub. */
const CONNECT_STATE_SECONDS = 15 * 60;

/** What a connect link carries to GitHub and back. */
export type ConnectState = {
  userId: string;
  /** Also in the browser's cookie (CONNECT_COOKIE): the code must come back
   *  to the browser that asked for it, never one a link was sent to. */
  nonce: string;
  /** Came back through the desktop shell's loopback. */
  desktop: boolean;
  next: ConnectReturn;
};

/** The cookie holding a connect's nonce and PKCE verifier, for its callback. */
export const CONNECT_COOKIE = "outrunner_gh_connect";

export function signConnectState(secret: string, state: ConnectState, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(
    JSON.stringify({ u: state.userId, n: state.nonce, d: state.desktop ? 1 : 0, x: state.next, e: nowSeconds + CONNECT_STATE_SECONDS }),
  ).toString("base64url");
  return `${payload}.${connectStateMac(secret, payload)}`;
}

/** The state a connect link carried, or null for one that isn't ours, was
 *  changed, or has expired. */
export function readConnectState(
  secret: string,
  value: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): ConnectState | null {
  const [payload, mac, ...rest] = value?.split(".") ?? [];
  if (!payload || !mac || rest.length > 0) return null;
  const expected = Buffer.from(connectStateMac(secret, payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, n, d, x, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof u !== "string" || typeof n !== "string" || !n || typeof e !== "number" || e < nowSeconds) return null;
    return { userId: u, nonce: n, desktop: d === 1, next: isConnectReturn(x) ? x : "/settings/connections" };
  } catch {
    return null;
  }
}

function connectStateMac(secret: string, payload: string): string {
  // Its own purpose, apart from install links and webhooks signed with the
  // same secret.
  return createHmac("sha256", secret).update(`connect-state:${payload}`).digest("base64url");
}

/** A fresh nonce and PKCE verifier, and the cookie value holding them. */
export function newConnectSecrets(): { nonce: string; verifier: string; cookie: string } {
  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  return { nonce, verifier, cookie: `${nonce}.${verifier}` };
}

/** The nonce and verifier a connect cookie holds, or null. */
export function readConnectCookie(value: string | undefined): { nonce: string; verifier: string } | null {
  const [nonce, verifier, ...rest] = value?.split(".") ?? [];
  return nonce && verifier && rest.length === 0 ? { nonce, verifier } : null;
}

/** Whether the cookie's nonce is the state's, in constant time. */
export function nonceMatches(state: ConnectState, cookie: { nonce: string } | null): boolean {
  if (!cookie) return false;
  const a = Buffer.from(state.nonce);
  const b = Buffer.from(cookie.nonce);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PKCE's S256 challenge for a verifier (RFC 7636). */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Where the user authorizes the App to act as them on GitHub. */
export function userAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  /** Let them pick another GitHub account than the one they're signed in to. */
  selectAccount?: boolean;
}): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: codeChallenge(input.verifier),
    code_challenge_method: "S256",
    allow_signup: "false",
    ...(input.selectAccount && { prompt: "select_account" }),
  });
  return `https://github.com/login/oauth/authorize?${query}`;
}

/** A user authorization's tokens, as GitHub gave them. */
export type UserTokens = {
  accessToken: string;
  /** Null where the App's tokens don't expire. */
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
};

type TokenAnswer = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
};

function toTokens(body: TokenAnswer, now: number): UserTokens | null {
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const seconds = (value: unknown) => (typeof value === "number" && value > 0 ? new Date(now + value * 1000) : null);
  return {
    accessToken: body.access_token,
    accessExpiresAt: seconds(body.expires_in),
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    refreshExpiresAt: seconds(body.refresh_token_expires_in),
  };
}

/** GitHub refused or failed a call about a user authorization; never carries
 *  a token. `code` is GitHub's OAuth error, when it said one. */
export class UserAuthError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.name = "UserAuthError";
    this.status = status;
    this.code = code;
  }
}

async function tokenRequest(
  doFetch: Fetch,
  body: Record<string, string>,
  now: number,
): Promise<{ tokens: UserTokens } | { refused: string }> {
  let response: Response;
  try {
    response = await doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UserAuthError("GitHub couldn't be reached.", null);
  }
  const answer = ((await response.json().catch(() => null)) ?? {}) as TokenAnswer;
  // GitHub answers an OAuth error with 200 and `error`.
  if (typeof answer.error === "string") return { refused: answer.error };
  const tokens = response.ok ? toTokens(answer, now) : null;
  if (!tokens) throw new UserAuthError(`GitHub didn't give a token (${response.status}).`, response.status);
  return { tokens };
}

/** The tokens a code from the authorize page is traded for; null for a code
 *  GitHub won't take (expired, used, not this verifier's). */
export async function exchangeUserCode(
  config: GitHubAppConfig,
  clientSecret: string,
  input: { code: string; redirectUri: string; verifier: string },
  doFetch: Fetch = fetch,
  now = Date.now(),
): Promise<UserTokens | null> {
  const result = await tokenRequest(
    doFetch,
    {
      client_id: config.clientId,
      client_secret: clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    now,
  );
  if ("tokens" in result) return result.tokens;
  if (result.refused === "bad_verification_code") return null;
  throw new UserAuthError(`GitHub refused the code (${result.refused}).`, null, result.refused);
}

/**
 * Renew a user authorization with its refresh token: new tokens, both of
 * them (the refresh token used stops working), or "revoked" when GitHub
 * won't take it (revoked, expired, or used already). Throws when GitHub
 * couldn't be asked, which says nothing about the token.
 */
export async function refreshUserTokens(
  config: GitHubAppConfig,
  clientSecret: string,
  refreshToken: string,
  doFetch: Fetch = fetch,
  now = Date.now(),
): Promise<UserTokens | "revoked"> {
  const result = await tokenRequest(
    doFetch,
    { client_id: config.clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    now,
  );
  if ("tokens" in result) return result.tokens;
  if (result.refused === "bad_refresh_token") return "revoked";
  throw new UserAuthError(`GitHub refused the refresh (${result.refused}).`, null, result.refused);
}

/** GitHub refused the App's own client credentials: GITHUB_APP_CLIENT_SECRET
 *  is wrong or was rotated, which no retry or reconnect mends. */
export const isMisconfigured = (error: unknown) =>
  error instanceof UserAuthError && error.code === "incorrect_client_credentials";

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "outrunner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function apiGet<T>(doFetch: Fetch, path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(`https://api.github.com${path}`, {
      headers: apiHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UserAuthError("GitHub couldn't be reached.", null);
  }
  if (!response.ok) throw new UserAuthError(`GitHub answered ${response.status} to GET ${path.split("?")[0]}`, response.status);
  return (await response.json()) as T;
}

/** The GitHub user a user token acts as. */
export async function userOfToken(token: string, doFetch: Fetch = fetch): Promise<{ id: number; login: string }> {
  const user = await apiGet<{ id?: unknown; login?: unknown }>(doFetch, "/user", token);
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || typeof user.login !== "string") {
    throw new UserAuthError("GitHub didn't say who the token is.", 200);
  }
  return { id: user.id, login: user.login };
}

/** An installation of the App a user token reaches, with its account's id. */
export type UserInstallation = Installation & { accountId: number | null };

/** The App's installations the user can reach: their own account's, and
 *  their GitHub organizations' (up to 100). */
export async function listUserInstallations(token: string, doFetch: Fetch = fetch): Promise<UserInstallation[]> {
  const data = await apiGet<{
    installations?: Array<{
      id: number;
      account: { login: string; type: string; id?: number } | null;
      repository_selection: string;
      suspended_at: string | null;
    }>;
  }>(doFetch, "/user/installations?per_page=100", token);
  return (data.installations ?? []).flatMap((raw) => {
    const installation = toInstallation(raw);
    return installation ? [{ ...installation, accountId: typeof raw.account?.id === "number" ? raw.account.id : null }] : [];
  });
}

/** The installation on the user's own GitHub account, if they installed it. */
export function ownInstallation(installations: UserInstallation[], githubUserId: number): UserInstallation | null {
  return installations.find((i) => i.accountType === "User" && i.accountId === githubUserId) ?? null;
}

type OAuthClient = { clientId: string; clientSecret: string };

/**
 * Revoke, as an OAuth client (`clientId`, with its secret): a user's whole
 * `grant` (every token of it, so the next authorization asks again), or one
 * `token`, leaving the grant. True when GitHub took it, or the token was
 * already gone (404: revoked, or never this client's); false when it
 * couldn't be done.
 */
async function revokeOAuth(client: OAuthClient, token: string, what: "grant" | "token", doFetch: Fetch): Promise<boolean> {
  try {
    const response = await doFetch(`https://api.github.com/applications/${encodeURIComponent(client.clientId)}/${what}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "outrunner",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}

/** Revoke a user's whole authorization of an OAuth client: the App's user
 *  authorization on disconnecting (or for a GitHub account that isn't
 *  theirs), and the old sign-in OAuth App's `repo` grant. */
export function revokeGrant(client: OAuthClient, token: string, doFetch: Fetch = fetch): Promise<boolean> {
  return revokeOAuth(client, token, "grant", doFetch);
}

/** Revoke one token of an OAuth client's, leaving its grant: for the token a
 *  GitHub sign-in hands Outrunner, once its emails are read. */
export function revokeToken(client: OAuthClient, token: string, doFetch: Fetch = fetch): Promise<boolean> {
  return revokeOAuth(client, token, "token", doFetch);
}

/** A user token is handed out until this long before it expires: a box's
 *  git may hold it a while. */
export const USER_TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** Whether an access token needs renewing before it's handed out. */
export function needsRenewal(expiresAt: Date | null, now: number, margin = USER_TOKEN_MARGIN_MS): boolean {
  return expiresAt !== null && expiresAt.getTime() - margin <= now;
}
