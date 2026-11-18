/**
 * A user's own GitHub access, for working as them (their GitHub identity
 * "personal", lib/github/identity.ts): a personal access token they pasted,
 * else their GitHub App user token from Settings → Connections (8 hours long,
 * renewed as it's asked for), else, while GITHUB_LEGACY_TOKENS allows it, the
 * token an older sign-in kept (lib/github/legacy-token.ts). The order is
 * lib/github/personal-choice.ts's.
 *
 * `userId` must come from a verified session or a box's signed request: the
 * stores below do no authorization of their own.
 */

import { getGithubConnection } from "@/lib/db/github-connections";
import { githubTokenSecret, githubTokenStatus } from "@/lib/db/github-tokens";
import { MissingGithubTokenError } from "@/lib/github/client";
import { legacyTokenMode, usableLegacyToken } from "@/lib/github/legacy-token";
import { isPersonalConnected, pickPersonalCredential, type PersonalCredential } from "@/lib/github/personal-choice";
import { githubUserToken } from "@/lib/github/user-connection.deps";
import { getGithubToken } from "@/lib/db/credentials";

export type { PersonalCredential };

/** The user's own credential, or null with none (pickPersonalCredential). */
export async function personalCredential(userId: string): Promise<PersonalCredential | null> {
  return pickPersonalCredential(userId, { pat: githubTokenSecret, appUser: githubUserToken, legacy: usableLegacyToken });
}

/** {@link personalCredential}'s token, or MissingGithubTokenError. */
export async function requirePersonalToken(userId: string): Promise<string> {
  const credential = await personalCredential(userId);
  if (!credential) throw new MissingGithubTokenError();
  return credential.token;
}

/** Whether the user has connected their own GitHub at all (isPersonalConnected). */
export async function personalConnected(userId: string): Promise<boolean> {
  return isPersonalConnected(userId, {
    hasToken: async (id) => (await githubTokenStatus(id)) !== null,
    hasAppConnection: async (id) => (await getGithubConnection(id)) !== null,
    hasLegacy: async (id) => legacyTokenMode() !== "off" && (await getGithubToken(id)) !== null,
  });
}
