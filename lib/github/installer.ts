/**
 * Who installed the App, asked of GitHub: for an admin with no GitHub account
 * linked (signed in with Google), or a different one from the one they
 * installed with. GitHub's webhook names the installer; the admin signs in
 * to GitHub for the App once (its user authorization), and the GitHub user
 * that comes back must be them for the installation to be the org's
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

/** The GitHub user id the code signs in, or null when GitHub won't say. The
 *  token it's traded for is revoked straight after. */
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
  });
  const { access_token: token } = ((await traded.json().catch(() => null)) ?? {}) as { access_token?: string };
  if (!traded.ok || !token) return null;
  try {
    const user = await doFetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    const { id } = ((await user.json().catch(() => null)) ?? {}) as { id?: unknown };
    return user.ok && typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } finally {
    await doFetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => undefined);
  }
}
