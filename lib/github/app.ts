/**
 * The Outrunner GitHub App: what the server does as the app rather than as a
 * signed-in user. Code review posts as the app (`outrunner[bot]`), so its
 * comments don't speak for whoever turned review on.
 *
 * One app per deployment (prod and staging each register their own), set by
 * GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY and
 * GITHUB_APP_WEBHOOK_SECRET. docs/github-app.md has the registration steps.
 *
 * The app's JWT is signed here with node:crypto (RS256), so no Octokit.
 */

import { createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual, type KeyObject } from "node:crypto";

import { optionalEnv } from "@/lib/env";
import { GitHubSyncError } from "@/lib/github/client";
import { type Installation, normalizeInstallation } from "@/lib/github/installation";

export type GitHubAppConfig = {
  appId: string;
  /** The app's URL name: github.com/apps/<slug>. */
  slug: string;
  privateKey: KeyObject;
  webhookSecret: string;
};

/** The app's configuration, or null when this deployment hasn't registered
 *  one (any of the four is missing, or the key isn't a private key): then
 *  the Automations page says so, and the webhook answers 503. */
export function githubAppConfig(): GitHubAppConfig | null {
  const appId = optionalEnv("GITHUB_APP_ID");
  const slug = optionalEnv("GITHUB_APP_SLUG");
  const pem = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = optionalEnv("GITHUB_APP_WEBHOOK_SECRET");
  if (!appId || !slug || !pem || !webhookSecret) return null;
  const privateKey = cachedPrivateKey(pem);
  return privateKey ? { appId, slug, privateKey, webhookSecret } : null;
}

/** The environment doesn't change while the server runs: the key is read
 *  once (once per value, so tests can swap it), and a bad one said once. */
let parsedKey: { pem: string; key: KeyObject | null } | null = null;

function cachedPrivateKey(pem: string): KeyObject | null {
  if (parsedKey?.pem !== pem) {
    parsedKey = { pem, key: appPrivateKey(pem) };
    if (!parsedKey.key) console.error("GITHUB_APP_PRIVATE_KEY is not a PEM private key: the GitHub App is off.");
  }
  return parsedKey.key;
}

/**
 * The app's private key as GitHub downloads it (a PEM file), or null. Secret
 * stores often flatten it to one line with literal `\n`s, or it's pasted as
 * base64 of the file: both are taken.
 */
export function appPrivateKey(value: string): KeyObject | null {
  const text = value.includes("-----BEGIN")
    ? value.replace(/\\n/g, "\n")
    : Buffer.from(value.trim(), "base64").toString("utf8");
  try {
    return createPrivateKey(text);
  } catch {
    return null;
  }
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * The JWT the app authenticates as itself with (RS256): issued a minute in
 * the past, for clock drift, and good for nine of GitHub's ten allowed
 * minutes. It only reads the app's installations and mints their tokens.
 */
export function appJwt(appId: string, privateKey: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * Whether a webhook delivery is GitHub's: `X-Hub-Signature-256` is
 * `sha256=<hex HMAC of the raw body>` under the app's webhook secret,
 * compared in constant time.
 */
export function isGitHubSignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A random value for the install round trip's `state`. */
export function installNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Where an admin installs the app; GitHub hands `state` back to the setup URL. */
export function installUrl(slug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

const REQUEST_TIMEOUT_MS = 15_000;

async function appRequest(
  config: GitHubAppConfig,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<Response> {
  try {
    return await fetch(new URL(path, "https://api.github.com"), {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJwt(config.appId, config.privateKey)}`,
        "User-Agent": "outrunner",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("GitHub App request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  }
}

/** One of the app's installations, read as the app; null when GitHub has
 *  none by that id (never installed, or uninstalled since). */
export async function getInstallation(config: GitHubAppConfig, id: number): Promise<Installation | null> {
  const response = await appRequest(config, `/app/installations/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    console.error("GitHub App installation read was rejected", { status: response.status });
    throw new GitHubSyncError("GitHub didn't answer for the Outrunner app. Try again.", response.status);
  }
  const installation = normalizeInstallation(await response.json().catch(() => null));
  if (!installation) throw new GitHubSyncError("GitHub sent an installation Outrunner couldn't read.");
  return installation;
}

export type InstallationToken = { token: string; expiresAt: string };

/**
 * A token acting as the app on one installation, good for an hour. Narrow it
 * to what the caller needs: `repositories` (names, without the owner) and
 * `permissions` (each at most what the app was granted). A review session
 * gets one repository with `pull_requests: write` and `contents: read`, so it
 * can comment and can't push.
 */
export async function createInstallationToken(
  config: GitHubAppConfig,
  id: number,
  scope: { repositories?: string[]; permissions?: Record<string, "read" | "write"> } = {},
): Promise<InstallationToken> {
  const response = await appRequest(config, `/app/installations/${id}/access_tokens`, {
    method: "POST",
    body: {
      ...(scope.repositories ? { repositories: scope.repositories } : {}),
      ...(scope.permissions ? { permissions: scope.permissions } : {}),
    },
  });
  if (!response.ok) {
    console.error("GitHub App token request was rejected", { status: response.status });
    throw new GitHubSyncError("GitHub wouldn't give the Outrunner app a token for this repository.", response.status);
  }
  const body = (await response.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
  if (typeof body?.token !== "string" || typeof body.expires_at !== "string") {
    throw new GitHubSyncError("GitHub sent a token Outrunner couldn't read.");
  }
  return { token: body.token, expiresAt: body.expires_at };
}

/** At most this many repositories are read from one installation (ten pages). */
const INSTALLATION_REPOS_PAGES = 10;

function githubGet(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "outrunner",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.error("GitHub request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  });
}

/**
 * The repositories an installation covers, as lower-case `owner/name`: read
 * with a token of its own, since GitHub lists them only to the installation.
 * `complete` is false past the page limit, when a repository missing from
 * `names` may still be covered.
 */
export async function listInstallationRepositories(
  config: GitHubAppConfig,
  id: number,
): Promise<{ names: Set<string>; complete: boolean }> {
  const { token } = await createInstallationToken(config, id, { permissions: { metadata: "read" } });
  const names = new Set<string>();
  for (let page = 1; page <= INSTALLATION_REPOS_PAGES; page++) {
    const response = await githubGet(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, token);
    if (!response.ok) {
      console.error("GitHub App repository listing was rejected", { status: response.status });
      throw new GitHubSyncError("GitHub wouldn't list the Outrunner app's repositories.", response.status);
    }
    const body = (await response.json().catch(() => null)) as { repositories?: { full_name?: unknown }[] } | null;
    const repositories = body?.repositories ?? [];
    for (const repository of repositories) {
      if (typeof repository.full_name === "string") names.add(repository.full_name.toLowerCase());
    }
    if (repositories.length < 100) return { names, complete: true };
  }
  return { names, complete: false };
}

/** Repositories checked for an admin's rights before giving up. */
const OWNERSHIP_CHECKS = 10;

/**
 * Whether a signed-in user may link an installation: it's on their own
 * account, or, on an organization, they're an admin of one of the
 * repositories it covers (`userToken` is their GitHub token, which sees
 * their permission on each). Installing an app on an organization takes an
 * owner, or an admin of the repositories picked, so either holds for whoever
 * installed it; a stranger who edited the id in the setup URL has neither.
 */
export async function userControlsInstallation(
  config: GitHubAppConfig,
  installation: Installation,
  user: { login: string; token: string | null },
): Promise<boolean> {
  if (installation.accountType === "User") {
    return installation.accountLogin.toLowerCase() === user.login.toLowerCase();
  }
  if (!user.token) return false;
  const { names } = await listInstallationRepositories(config, installation.installationId);
  for (const fullName of [...names].slice(0, OWNERSHIP_CHECKS)) {
    const response = await githubGet(`https://api.github.com/repos/${fullName}`, user.token);
    if (!response.ok) continue;
    const repo = (await response.json().catch(() => null)) as { permissions?: { admin?: unknown } } | null;
    if (repo?.permissions?.admin === true) return true;
  }
  return false;
}
