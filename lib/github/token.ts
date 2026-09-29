/**
 * Resolving the GitHub token a request should act with.
 *
 * Runtime used to act as one server-wide `GITHUB_PAT` for everybody. Now every
 * repository operation runs as the signed-in user, using the token captured
 * from their own OAuth sign-in. Routes call {@link requireGithubToken} and let
 * {@link MissingGithubTokenError} become a 409 telling the user to reconnect.
 */

import { getGithubToken } from "@/lib/db/credentials";

/**
 * The user has no usable GitHub token. Recoverable, and always by the same
 * action: sign out and back in so the OAuth round trip mints a fresh one.
 *
 * Reached when the user last signed in before the `repo` scope was requested,
 * when they revoked the app on GitHub's side, or when a stored token could not
 * be decrypted (see lib/db/credentials.ts).
 */
export class MissingGithubTokenError extends Error {
  constructor() {
    super("Connect your GitHub account: sign out and back in to grant repository access.");
    this.name = "MissingGithubTokenError";
  }
}

/**
 * The signed-in user's GitHub token, or throw {@link MissingGithubTokenError}.
 *
 * `userId` must come from the verified session — it is passed straight to the
 * service-role credential store, which does no authorization of its own.
 */
export async function requireGithubToken(userId: string): Promise<string> {
  const token = await getGithubToken(userId);
  if (!token) throw new MissingGithubTokenError();
  return token;
}

/**
 * Like {@link requireGithubToken} but yields undefined instead of throwing, for
 * paths where GitHub access is optional (a workspace on an already-cloned
 * mirror can start without one; only a fetch or push needs it).
 */
export async function optionalGithubToken(userId: string): Promise<string | undefined> {
  return (await getGithubToken(userId)) ?? undefined;
}
