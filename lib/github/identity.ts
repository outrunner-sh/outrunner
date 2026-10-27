/**
 * Who a session's git acts as on GitHub: clone, fetch, push, and pull
 * requests. Each user chooses (Settings → Account → GitHub identity):
 *
 * - **My GitHub account** (`personal`, everyone's at first): their own token
 *   from signing in, as every session had before the App. Pushes and pull
 *   requests show as them.
 * - **Outrunner App** (`app`): a token of the Outrunner GitHub App's
 *   installation on the repository's account in the session's org, for that
 *   one repository, an hour long. Pushes and pull requests show as the App;
 *   commits keep the member as their author. A member with read access to a
 *   project gets a token that can only read it.
 *
 * Neither falls back to the other: a member who chose the App and whose org
 * hasn't installed it on the repository's account is told so, with where to
 * fix it, rather than quietly pushing as themselves.
 *
 * A box asks for its tokens as git needs them (app/api/runtime/git-credential),
 * since the App's expire within the hour; the server's own git calls (the
 * box's mirror, pull request status, merging) ask here too, through
 * identity.deps.ts, which wires this to the database and GitHub.
 */

import type { GitHubIdentity } from "@/lib/db/credentials";
import type { OrgInstallation } from "@/lib/db/github-installations";
import {
  GitHubAppError,
  type GitHubAppConfig,
  type InstallationToken,
  type TokenPermissions,
} from "@/lib/github/app";
import { GitHubSyncError, MissingGithubTokenError } from "@/lib/github/client";
import { GitIdentityError } from "@/lib/github/identity-error";
import { installationSettingsUrl } from "@/lib/github/listing";
import type { AccessLevel } from "@/lib/orgs/access";

export type { GitHubIdentity };
export { GitIdentityError, type GitIdentityRefusal } from "@/lib/github/identity-error";

export type GitCredential = {
  identity: GitHubIdentity;
  token: string;
  /** When the token stops working; null for the user's own, which lasts. */
  expiresAt: Date | null;
};

/** What resolving takes, apart from the request: tests pass their own. */
export type IdentityDeps = {
  identity(userId: string): Promise<GitHubIdentity>;
  personalToken(userId: string): Promise<string | null>;
  config(): GitHubAppConfig | null;
  installations(orgId: string): Promise<OrgInstallation[]>;
  mint(config: GitHubAppConfig, installationId: number, repo: string, permissions?: TokenPermissions): Promise<InstallationToken>;
  /** Tokens made, kept until shortly before they expire. */
  cache: Map<string, InstallationToken>;
  now(): number;
};

/** A token kept is handed out until this long before it expires: git on the
 *  box may hold it a while. */
const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** What a member with only read access to a project may do with it. */
const READ_ONLY: TokenPermissions = { contents: "read", pull_requests: "read", metadata: "read" };

const SWITCH = "or choose your own GitHub account in Settings → Account";

/**
 * A credential for `repo` (owner/name) as `userId` chose, in `orgId`, for a
 * member whose access to it is `level`. Throws MissingGithubTokenError (their
 * own, with none stored) or GitIdentityError (the App's, with no way to it).
 */
export async function resolveGitCredential(
  input: { userId: string; orgId: string; repo: string; level?: AccessLevel; identity?: GitHubIdentity },
  deps: IdentityDeps,
): Promise<GitCredential> {
  const identity = input.identity ?? (await deps.identity(input.userId));
  if (identity === "personal") {
    const token = await deps.personalToken(input.userId);
    if (!token) throw new MissingGithubTokenError();
    return { identity, token, expiresAt: null };
  }

  const config = deps.config();
  if (!config) {
    throw new GitIdentityError(
      "app_unconfigured",
      `Outrunner's GitHub App isn't set up here. Choose your own GitHub account in Settings → Account.`,
      "/settings/account",
    );
  }
  const [owner, name] = input.repo.split("/");
  const installation = (await deps.installations(input.orgId)).find(
    (i) => i.accountLogin.toLowerCase() === owner?.toLowerCase(),
  );
  if (!installation || !name) {
    throw new GitIdentityError(
      "no_installation",
      `Outrunner's GitHub App isn't installed on ${owner} for this org. Install it in Settings → Org → GitHub, ${SWITCH}.`,
      "/settings/org/github",
    );
  }
  const manage = installationSettingsUrl({
    installationId: installation.id,
    login: installation.accountLogin,
    type: installation.accountType,
  });
  if (installation.suspended) {
    throw new GitIdentityError(
      "suspended",
      `Outrunner's GitHub App is suspended on ${installation.accountLogin}. Unsuspend it on GitHub, ${SWITCH}.`,
      manage,
    );
  }

  const level = input.level ?? "write";
  const key = `${installation.id}/${name.toLowerCase()}/${level}`;
  const kept = deps.cache.get(key);
  if (kept && kept.expiresAt.getTime() - TOKEN_MARGIN_MS > deps.now()) {
    return { identity, token: kept.token, expiresAt: kept.expiresAt };
  }
  let minted: InstallationToken;
  try {
    minted = await deps.mint(config, installation.id, name, level === "read" ? READ_ONLY : undefined);
  } catch (error) {
    if (!(error instanceof GitHubAppError)) throw error;
    // 422: the installation doesn't reach that repository (its owner picked
    // others); 404: it's gone from GitHub since.
    if (error.status === 422 || error.status === 404) {
      throw new GitIdentityError(
        "unreachable",
        `Outrunner's GitHub App can't reach ${input.repo}. Add it to the App's repositories on GitHub, ${SWITCH}.`,
        manage,
      );
    }
    console.error(`GitHub App: no token for ${input.repo} (installation ${installation.id})`, error);
    throw new GitHubSyncError("Outrunner's GitHub App couldn't get a token from GitHub. Try again.", error.status);
  }
  deps.cache.set(key, minted);
  return { identity, token: minted.token, expiresAt: minted.expiresAt };
}
