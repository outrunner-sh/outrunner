/**
 * Who installed the App, asked of GitHub: for an admin with no GitHub account
 * linked (signed in with Google), or a different one from the one they
 * installed with. GitHub's webhook names the installer; the admin signs in
 * to GitHub for the App once (its user authorization), and the GitHub user
 * that comes back must be them for the installation's first org connection
 * (claimInstallation). Nothing is kept: the user token is revoked at once.
 *
 * Needs GITHUB_APP_CLIENT_SECRET, and the App's Callback URL to include
 * `<app>/api/github/app/verify`.
 */

import { optionalEnv } from "@/lib/env";
import type { GitHubAppConfig } from "@/lib/github/app";

type Fetch = typeof fetch;

/** The App's client secret, or null when it isn't set here. */
export function appClientSecret(): string | null {
  return optionalEnv("GITHUB_APP_CLIENT_SECRET") ?? null;
}

/** Where the admin signs in to GitHub for the App, coming back to
 *  `redirectUri` with a code and `state`. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${query}`;
}

/** How long each call to GitHub below waits: the user is on the page. */
const GITHUB_TIMEOUT_MS = 15_000;

/** The GitHub user id the code signs in, or null for a code GitHub won't
 *  take (expired, used). Throws when GitHub doesn't answer as it should, so
 *  a hiccup is "try again", not "you aren't the installer". The token it's
 *  traded for is revoked straight after. */
export async function githubUserFromCode(
  config: GitHubAppConfig,
  clientSecret: string,
  code: string,
  redirectUri: string,
  doFetch: Fetch = fetch,
): Promise<number | null> {
  const traded = await doFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const body = ((await traded.json().catch(() => null)) ?? {}) as { access_token?: string; error?: string };
  if (body.error === "bad_verification_code") return null;
  const token = body.access_token;
  if (!traded.ok || !token) throw new Error(`GitHub didn't trade the code (${traded.status} ${body.error ?? ""})`);
  try {
    const user = await doFetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!user.ok) throw new Error(`GitHub didn't say who signed in (${user.status})`);
    const { id } = ((await user.json().catch(() => null)) ?? {}) as { id?: unknown };
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } finally {
    await doFetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}
