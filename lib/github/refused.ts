/**
 * What a GitHub 401 means depends on whose token GitHub refused, and the
 * client can't tell (lib/github/client.ts maps every 401 to
 * GitHubReconnectError). Told "your GitHub connection has expired", a user
 * reconnects, and that fixes nothing when the token refused was the
 * Outrunner App's (an hour long, minted by the server) or their own token was
 * fine and GitHub only said no for the moment.
 *
 * So a call made with a git credential (lib/github/identity.ts) goes through
 * {@link callWithCredential}: an App token refused is forgotten and one minted
 * afresh, once, and never becomes "reconnect"; the user's own becomes
 * "reconnect" only once GitHub confirms it dead (`GET /user` with it is
 * refused too). Each refusal is logged with what it was (never the token: its
 * 4-character prefix) so the next one can be told apart from the logs.
 *
 * Its collaborators come in as {@link RefusalDeps}: tests pass their own.
 */

import { GitHubReconnectError, GitHubSyncError } from "@/lib/github/client";
import type { GitCredential } from "@/lib/github/identity";

/** An installation token's lifetime, as GitHub mints them: its age is this
 *  less what it has left. */
const INSTALLATION_TOKEN_MS = 60 * 60 * 1000;

/** GitHub's word on a personal token when asked again (`GET /user`). */
export type TokenVerdict = "dead" | "alive" | "unknown";

export type RefusalDeps = {
  /** A credential for the call, as the user chose (minted, or kept). */
  resolve(): Promise<GitCredential>;
  /** Forget a kept App token, so the next {@link resolve} mints one. */
  forget(credential: GitCredential): void;
  /** Ask GitHub whether the user's own token still works. */
  check(token: string): Promise<TokenVerdict>;
  /** When the user's own token was stored; null when not known. */
  storedAt(): Promise<Date | null>;
  log(entry: RefusalLog): void;
  now(): number;
};

/** What a refusal is logged as: enough to tell the causes apart, no secret. */
export type RefusalLog = {
  route: string;
  repo: string;
  kind: "personal" | "installation";
  /** The token's first 4 characters (`gho_`, `ghu_`, `ghs_`). */
  prefix: string;
  /** Minutes since the token was minted (App) or stored (personal). */
  ageMinutes: number | null;
  installationId: number | null;
  status: number | undefined;
  attempt: number;
  /** For a personal token, what asking GitHub again said. */
  verdict?: TokenVerdict;
};

export function tokenPrefix(token: string): string {
  return token.slice(0, 4);
}

/**
 * `call` with a token for `repo`, as {@link RefusalDeps.resolve} gives it.
 * Throws GitHubReconnectError only when the user's own token is confirmed
 * dead; an App token refused twice, or a personal one GitHub still takes, is
 * a GitHubSyncError (retry, not reconnect).
 */
export async function callWithCredential<T>(
  where: { route: string; repo: string },
  call: (token: string) => Promise<T>,
  deps: RefusalDeps,
): Promise<T> {
  const first = await deps.resolve();
  try {
    return await call(first.token);
  } catch (error) {
    if (!(error instanceof GitHubReconnectError)) throw error;

    if (first.installationId !== null) {
      deps.log(await entry(where, first, error, 1, deps));
      deps.forget(first);
      const fresh = await deps.resolve();
      try {
        return await call(fresh.token);
      } catch (again) {
        if (!(again instanceof GitHubReconnectError)) throw again;
        deps.log(await entry(where, fresh, again, 2, deps));
        throw new GitHubSyncError(
          `GitHub refused Outrunner's GitHub App for ${where.repo}. Try again, or check the App in Settings → Org → GitHub.`,
          again.status,
        );
      }
    }

    const verdict = await deps.check(first.token);
    deps.log({ ...(await entry(where, first, error, 1, deps)), verdict });
    if (verdict === "dead") throw error;
    throw new GitHubSyncError(
      verdict === "alive"
        ? "GitHub turned that request down just now, but your GitHub connection still works. Try again."
        : "GitHub couldn't be reached to check your connection. Try again.",
      error.status,
    );
  }
}

async function entry(
  where: { route: string; repo: string },
  credential: GitCredential,
  error: GitHubReconnectError,
  attempt: number,
  deps: RefusalDeps,
): Promise<RefusalLog> {
  const installation = credential.installationId !== null;
  const since = installation
    ? credential.expiresAt && new Date(credential.expiresAt.getTime() - INSTALLATION_TOKEN_MS)
    : await deps.storedAt().catch(() => null);
  return {
    route: where.route,
    repo: where.repo,
    kind: installation ? "installation" : "personal",
    prefix: tokenPrefix(credential.token),
    ageMinutes: since ? Math.round((deps.now() - since.getTime()) / 60_000) : null,
    installationId: credential.installationId,
    status: error.status,
    attempt,
  };
}
