/**
 * Resolving the GitHub token a request should act with, as the user.
 *
 * Runtime used to act as one server-wide `GITHUB_PAT` for everybody, then as
 * the token each user's GitHub sign-in minted. Now it's the user's own GitHub
 * connection (lib/github/personal.ts): the Outrunner GitHub App's user token
 * from Settings → Connections, or an old sign-in token while those are still
 * allowed. Routes call {@link requireGithubToken} and let
 * {@link MissingGithubTokenError} become a 409 telling the user to connect.
 */

import { MissingGithubTokenError } from "@/lib/github/client";
import { personalCredential, requirePersonalToken } from "@/lib/github/personal";

export { MissingGithubTokenError };

/**
 * The signed-in user's GitHub token, or throw {@link MissingGithubTokenError}.
 *
 * `userId` must come from the verified session — it is passed straight to the
 * service-role credential store, which does no authorization of its own.
 */
export async function requireGithubToken(userId: string): Promise<string> {
  return requirePersonalToken(userId);
}

/**
 * Like {@link requireGithubToken} but yields undefined instead of throwing, for
 * paths where GitHub access is optional (a workspace on an already-cloned
 * mirror can start without one; only a fetch or push needs it).
 */
export async function optionalGithubToken(userId: string): Promise<string | undefined> {
  try {
    return (await personalCredential(userId))?.token;
  } catch (error) {
    if (!(error instanceof MissingGithubTokenError)) throw error;
    return undefined;
  }
}
