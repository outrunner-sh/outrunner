/**
 * A user's GitHub App user token, renewed as it's asked for: the access token
 * is handed out while it has more than USER_TOKEN_MARGIN_MS left, and
 * renewed with the refresh token otherwise. Only a refresh token GitHub
 * refuses (revoked, expired) breaks the connection, for the user to connect
 * again; GitHub being unreachable is "try again".
 *
 * GitHub takes each refresh token once, and gives a new one with every
 * renewal. Servers therefore claim a renewal (claimGithubRefresh) and the
 * others wait for it, and a renewal is saved only over the refresh token it
 * used. A refresh token refused because another server spent it first is no
 * break: the row has moved on, and its new token is used.
 *
 * Its collaborators are passed in (user-connection.deps.ts wires them), so it
 * tests without a database or GitHub.
 */

import type { GitHubConnection } from "@/lib/db/github-connections";
import { GitHubSyncError, MissingGithubTokenError } from "@/lib/github/client";
import { isMisconfigured, needsRenewal, type UserTokens } from "@/lib/github/user-auth";

/** The connection is there but GitHub won't renew it: connect again. */
export class GitHubConnectionBrokenError extends MissingGithubTokenError {
  constructor() {
    super();
    this.message = "GitHub stopped renewing Outrunner's access to your repositories. Reconnect GitHub in Settings → Connections.";
    this.name = "GitHubConnectionBrokenError";
  }
}

/** A user token, and when it stops working (null: the App's don't expire). */
export type UserToken = { token: string; expiresAt: Date | null; githubUserId: number; login: string };

export type UserConnectionDeps = {
  read(userId: string): Promise<GitHubConnection | null>;
  claim(userId: string, seconds: number): Promise<boolean>;
  release(userId: string): Promise<void>;
  saveRefreshed(userId: string, usedRefreshCiphertext: string, tokens: UserTokens): Promise<boolean>;
  markBroken(userId: string, usedRefreshCiphertext: string | null): Promise<void>;
  /** GitHub's renewal (refreshUserTokens), as the App. */
  refresh(refreshToken: string): Promise<UserTokens | "revoked">;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/** How long a claim on a renewal lasts: a renewal is one request to GitHub. */
const CLAIM_SECONDS = 30;
/** How long a server waits on another's renewal, in steps. */
const WAIT_STEP_MS = 400;
const WAIT_STEPS = 15;

const toToken = (c: GitHubConnection): UserToken => ({
  token: c.accessToken,
  expiresAt: c.accessExpiresAt,
  githubUserId: c.githubUserId,
  login: c.githubLogin,
});

/** Usable as it is: not broken, with time left. */
const fresh = (c: GitHubConnection | null, now: number): boolean =>
  c !== null && !c.broken && c.accessToken !== "" && !needsRenewal(c.accessExpiresAt, now);

/** Still works at all, if only for a little while. */
const unexpired = (c: GitHubConnection | null, now: number): boolean =>
  c !== null && !c.broken && c.accessToken !== "" && (c.accessExpiresAt === null || c.accessExpiresAt.getTime() > now);

/**
 * The user's GitHub App user token, renewed if it's due: null when they never
 * connected. Throws GitHubConnectionBrokenError when the connection can't be
 * renewed, and GitHubSyncError when GitHub can't be asked and the token held
 * has run out.
 */
export async function userAccessToken(userId: string, deps: UserConnectionDeps): Promise<UserToken | null> {
  let connection = await deps.read(userId);
  if (!connection) return null;
  if (connection.broken) throw new GitHubConnectionBrokenError();
  if (fresh(connection, deps.now())) return toToken(connection);
  if (!connection.refreshToken || !connection.refreshCiphertext) {
    // Expiring without a way to renew: nothing to do but connect again.
    await deps.markBroken(userId, connection.refreshCiphertext);
    throw new GitHubConnectionBrokenError();
  }

  for (let step = 0; step < WAIT_STEPS; step++) {
    if (await deps.claim(userId, CLAIM_SECONDS)) return renew(userId, deps);
    // Another server is renewing it: wait for what it saves.
    await deps.sleep(WAIT_STEP_MS);
    connection = await deps.read(userId);
    if (!connection) return null;
    if (connection.broken) throw new GitHubConnectionBrokenError();
    if (fresh(connection, deps.now())) return toToken(connection);
  }
  if (unexpired(connection, deps.now())) return toToken(connection);
  throw new GitHubSyncError("Outrunner is renewing its access to your GitHub repositories. Try again in a moment.");
}

/** Renew, holding the claim. */
async function renew(userId: string, deps: UserConnectionDeps): Promise<UserToken | null> {
  // Read again under the claim: another server may have just renewed it.
  const current = await deps.read(userId);
  if (!current) {
    await deps.release(userId).catch(() => undefined);
    return null;
  }
  if (current.broken) {
    await deps.release(userId).catch(() => undefined);
    throw new GitHubConnectionBrokenError();
  }
  if (fresh(current, deps.now())) {
    await deps.release(userId).catch(() => undefined);
    return toToken(current);
  }
  if (!current.refreshToken || !current.refreshCiphertext) {
    await deps.markBroken(userId, current.refreshCiphertext);
    throw new GitHubConnectionBrokenError();
  }
  if (current.refreshExpiresAt && current.refreshExpiresAt.getTime() <= deps.now()) {
    await deps.markBroken(userId, current.refreshCiphertext);
    throw new GitHubConnectionBrokenError();
  }

  let renewed: UserTokens | "revoked";
  try {
    renewed = await deps.refresh(current.refreshToken);
  } catch (error) {
    await deps.release(userId).catch(() => undefined);
    // The deployment's to fix, for every user: said each time, loudly.
    if (isMisconfigured(error)) {
      console.error("GitHub refused the App's client credentials renewing a user token: check GITHUB_APP_CLIENT_SECRET");
    }
    // GitHub out of reach: the token held, while it lasts.
    if (unexpired(current, deps.now())) return toToken(current);
    console.error(`GitHub: couldn't renew user ${userId}'s token`, error);
    throw new GitHubSyncError("Couldn't renew Outrunner's access to your GitHub repositories. Try again.");
  }

  if (renewed === "revoked") {
    // Spent by another server first, the row has moved on; else it's broken.
    await deps.markBroken(userId, current.refreshCiphertext);
    const after = await deps.read(userId);
    if (after && fresh(after, deps.now())) return toToken(after);
    throw new GitHubConnectionBrokenError();
  }

  if (await deps.saveRefreshed(userId, current.refreshCiphertext, renewed)) {
    return { token: renewed.accessToken, expiresAt: renewed.accessExpiresAt, githubUserId: current.githubUserId, login: current.githubLogin };
  }
  // Connected again or disconnected meanwhile: what's stored now wins.
  const after = await deps.read(userId);
  if (!after) return null;
  if (fresh(after, deps.now())) return toToken(after);
  throw new GitHubConnectionBrokenError();
}
