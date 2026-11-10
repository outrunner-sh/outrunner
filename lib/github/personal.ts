/**
 * A user's own GitHub access, for working as them (their GitHub identity
 * "personal", lib/github/identity.ts): their GitHub App user token from
 * Settings → Connections (8 hours long, renewed as it's asked for), else,
 * while GITHUB_LEGACY_TOKENS allows it, the token an older sign-in kept
 * (lib/github/legacy-token.ts).
 *
 * `userId` must come from a verified session or a box's signed request: the
 * stores below do no authorization of their own.
 */

import { getGithubConnection } from "@/lib/db/github-connections";
import { MissingGithubTokenError } from "@/lib/github/client";
import { legacyTokenMode, usableLegacyToken } from "@/lib/github/legacy-token";
import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";
import { githubUserToken } from "@/lib/github/user-connection.deps";
import { getGithubToken } from "@/lib/db/credentials";

export type PersonalCredential = {
  token: string;
  /** Null for an old sign-in token, which never expires. */
  expiresAt: Date | null;
  source: "app_user" | "legacy";
};

/**
 * The user's own credential, or null with none. A connection GitHub won't
 * renew falls back to an old sign-in token where one may be used, else
 * throws GitHubConnectionBrokenError (connect again).
 */
export async function personalCredential(userId: string): Promise<PersonalCredential | null> {
  let broken: unknown = null;
  try {
    const user = await githubUserToken(userId);
    if (user) return { token: user.token, expiresAt: user.expiresAt, source: "app_user" };
  } catch (error) {
    if (!(error instanceof GitHubConnectionBrokenError)) throw error;
    broken = error;
  }
  const legacy = await usableLegacyToken(userId);
  if (legacy) return { token: legacy, expiresAt: null, source: "legacy" };
  if (broken) throw broken;
  return null;
}

/** {@link personalCredential}'s token, or MissingGithubTokenError. */
export async function requirePersonalToken(userId: string): Promise<string> {
  const credential = await personalCredential(userId);
  if (!credential) throw new MissingGithubTokenError();
  return credential.token;
}

/**
 * Whether the user has connected their own GitHub at all (a connection,
 * broken or not, or an old sign-in token that may be used): one who has is
 * told to reconnect when it fails, rather than quietly working as the App.
 */
export async function personalConnected(userId: string): Promise<boolean> {
  if (await getGithubConnection(userId)) return true;
  return legacyTokenMode() !== "off" && (await getGithubToken(userId)) !== null;
}
