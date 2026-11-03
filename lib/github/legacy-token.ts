/**
 * The old way a user's repositories were reached: the token signing in with
 * GitHub minted, with the `repo` scope (user_credentials.github_token_*). It
 * never expires and reaches every repository the user can, so it's on its way
 * out (Settings → Connections → GitHub replaces it), by GITHUB_LEGACY_TOKENS:
 *
 * - `store`: as before. Sign-in asks for `repo` and keeps its token, which
 *   repository work runs as. The default only where users can't connect
 *   through the App (no GITHUB_APP_CLIENT_SECRET), so a deployment without it
 *   doesn't lose repository access.
 * - `fallback` (the default otherwise): sign-in is identity alone and keeps
 *   nothing. A token kept from before still works for a user who hasn't
 *   connected through the App, with a banner asking them to; connecting
 *   removes it.
 * - `off`: kept tokens are never used. The cutover, once users have moved.
 *
 * Removing one revokes it on GitHub too, when GITHUB_OAUTH_CLIENT_ID and
 * GITHUB_OAUTH_CLIENT_SECRET name the OAuth App that Supabase signs in with
 * (its whole grant, so the next sign-in asks GitHub for the narrower scopes).
 */

import { clearGithubToken, getGithubToken } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";
import { appClientSecret } from "@/lib/github/installer";
import { githubAppConfig } from "@/lib/github/app";
import { legacyModeFrom, type LegacyTokenMode, signInScopesFor } from "@/lib/github/legacy-mode";
import { revokeGrant, revokeToken } from "@/lib/github/user-auth";

export { legacyModeFrom, type LegacyTokenMode, signInScopesFor };

/** The mode this deployment runs in. */
export function legacyTokenMode(): LegacyTokenMode {
  return legacyModeFrom(optionalEnv("GITHUB_LEGACY_TOKENS"), githubAppConfig() !== null && appClientSecret() !== null);
}

/** What signing in with GitHub asks for here (components/signin-button.tsx). */
export function githubSignInScopes(): string {
  return signInScopesFor(legacyTokenMode());
}

/** The token kept from sign-in, if it may still be used. */
export async function usableLegacyToken(userId: string): Promise<string | null> {
  if (legacyTokenMode() === "off") return null;
  return getGithubToken(userId);
}

/** The sign-in OAuth App's credentials, to revoke what it granted. */
export function oauthApp(): { clientId: string; clientSecret: string } | null {
  const clientId = optionalEnv("GITHUB_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GITHUB_OAUTH_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Forget the user's kept sign-in token, revoking it on GitHub first where
 * that can be done. `revoked` says whether GitHub took it back: false where
 * the OAuth App's credentials aren't set, or GitHub couldn't be asked (it's
 * forgotten here either way).
 */
export async function removeLegacyToken(userId: string): Promise<{ removed: boolean; revoked: boolean }> {
  const token = await getGithubToken(userId);
  if (!token) {
    await clearGithubToken(userId);
    return { removed: false, revoked: false };
  }
  const app = oauthApp();
  const revoked = app ? await revokeGrant(app, token) : false;
  if (app && !revoked) console.error(`Couldn't revoke user ${userId}'s old GitHub sign-in token on GitHub; forgetting it anyway`);
  await clearGithubToken(userId);
  return { removed: true, revoked };
}

/**
 * Revoke the token a GitHub sign-in just handed over, once it's been used to
 * read the user's emails: nothing keeps it, and Supabase's session carries a
 * copy. Only where the OAuth App's credentials are set, and never in `store`
 * mode, which keeps it. Never throws.
 */
export async function revokeSignInToken(token: string): Promise<void> {
  const app = oauthApp();
  if (!app || legacyTokenMode() === "store") return;
  if (!(await revokeToken(app, token))) console.warn("Couldn't revoke a GitHub sign-in's token after reading its emails");
}
