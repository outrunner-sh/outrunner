/**
 * Real wiring for lib/github/user-connection.ts: the connection store and
 * GitHub, as the App. One renewal per user at a time on this server too, for
 * everyone asking meanwhile (a box's git asks at every fetch and push).
 */

import {
  claimGithubRefresh,
  getGithubConnection,
  markGithubConnectionBroken,
  releaseGithubRefresh,
  saveRefreshedGithubTokens,
} from "@/lib/db/github-connections";
import { githubAppConfig } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import { refreshUserTokens, UserAuthError } from "@/lib/github/user-auth";
import { userAccessToken, type UserConnectionDeps, type UserToken } from "@/lib/github/user-connection";

/** Whether this deployment can connect users' GitHub through the App: the
 *  App, and its client secret. */
export function userAuthConfigured(): boolean {
  return githubAppConfig() !== null && appClientSecret() !== null;
}

const deps: UserConnectionDeps = {
  read: getGithubConnection,
  claim: (userId, seconds) => claimGithubRefresh(userId, seconds),
  release: releaseGithubRefresh,
  saveRefreshed: saveRefreshedGithubTokens,
  markBroken: markGithubConnectionBroken,
  refresh: async (refreshToken) => {
    const config = githubAppConfig();
    const secret = appClientSecret();
    if (!config || !secret) throw new UserAuthError("The GitHub App's client secret isn't set here.", null);
    return refreshUserTokens(config, secret, refreshToken);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const underway = new Map<string, Promise<UserToken | null>>();

/** {@link userAccessToken}, as the app runs it. */
export function githubUserToken(userId: string): Promise<UserToken | null> {
  const running = underway.get(userId);
  if (running) return running;
  const asked = userAccessToken(userId, deps).finally(() => underway.delete(userId));
  underway.set(userId, asked);
  return asked;
}
