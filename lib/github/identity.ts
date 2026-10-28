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
 * fix it, rather than quietly pushing as themselves. The one exception is a
 * member with no GitHub account linked at all (signed in with Google), who
 * can't have chosen their own: there's none to act as, so it's the App where
 * it reaches the repository, and nothing (a public clone) where it doesn't.
 * One with GitHub linked whose token is gone is still told to reconnect.
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
  /** Whether the user has a GitHub account linked at all (signed in with it). */
  githubLinked(userId: string): Promise<boolean>;
  config(): GitHubAppConfig | null;
  installations(orgId: string): Promise<OrgInstallation[]>;
  /** The member's level on `repo` as a project of the org; null when it isn't
   *  one, or isn't theirs to work on. */
  repoLevel(userId: string, orgId: string, repo: string): Promise<AccessLevel | null>;
  /** What an installation was granted (installationPermissions); `fresh`
   *  asks GitHub rather than a copy kept. */
  granted(config: GitHubAppConfig, installationId: number, fresh: boolean): Promise<Record<string, string>>;
  mint(config: GitHubAppConfig, installationId: number, repo: string, permissions?: TokenPermissions): Promise<InstallationToken>;
  /** Tokens made, kept until shortly before they expire. */
  cache: Map<string, InstallationToken>;
  now(): number;
};

/** A token kept is handed out until this long before it expires: git on the
 *  box may hold it a while. */
const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** What a token is asked for: a member's level, or an automation's review. */
export type TokenLevel = AccessLevel | "review";

/** What a token is for, by the member's level: a session's git and gh, and
 *  the server reading a pull request's checks. Never more than this, whatever
 *  else the App may be given later; and never more than its installation was
 *  granted ({@link narrowPermissions}). `review` is an automation's review
 *  session's: it reads the code and writes to pull requests (comments; the
 *  permission also covers closing, editing and approving them), for a member
 *  with write access, and can't push. */
const WANTED: Record<TokenLevel, TokenPermissions> = {
  review: { contents: "read", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" },
  read: { contents: "read", pull_requests: "read", checks: "read", statuses: "read", metadata: "read" },
  write: {
    contents: "write",
    pull_requests: "write",
    // Pushing a change to .github/workflows; installations may not grant it.
    workflows: "write",
    checks: "read",
    statuses: "read",
    metadata: "read",
  },
};

/** `wanted`, as far as `granted` allows: GitHub refuses a token asking for
 *  more than its installation has. */
export function narrowPermissions(wanted: TokenPermissions, granted: Record<string, string>): TokenPermissions {
  const narrowed: TokenPermissions = {};
  for (const [name, level] of Object.entries(wanted) as Array<[keyof TokenPermissions, "read" | "write"]>) {
    const has = granted[name];
    if (has !== "read" && has !== "write" && has !== "admin") continue;
    narrowed[name] = level === "write" && has === "read" ? "read" : level;
  }
  return narrowed;
}

const SWITCH = "or choose your own GitHub account in Settings → Account";

/**
 * A credential for `repo` (owner/name) as `userId` chose, in `orgId`. Their
 * own reaches what their GitHub account does. The App's only a project of the
 * org they have access to, at their level on it, or read at most with `level`
 * "read". Throws MissingGithubTokenError (their own, with none stored) or
 * GitIdentityError (the App's, with no way to it).
 */
export async function resolveGitCredential(
  input: { userId: string; orgId: string; repo: string; level?: TokenLevel; identity?: GitHubIdentity },
  deps: IdentityDeps,
): Promise<GitCredential> {
  const identity = input.identity ?? (await deps.identity(input.userId));
  if (identity === "personal") {
    const token = await deps.personalToken(input.userId);
    if (token) return { identity, token, expiresAt: null };
    // No GitHub account at all: the App, where it reaches the repository.
    if (input.identity || (await deps.githubLinked(input.userId))) throw new MissingGithubTokenError();
    try {
      return await resolveGitCredential({ ...input, identity: "app" }, deps);
    } catch (error) {
      if (error instanceof GitIdentityError) throw new MissingGithubTokenError();
      throw error;
    }
  }

  // The App reaches the org's repositories, not the member: what they may do
  // with one is Outrunner's to say.
  const access = await deps.repoLevel(input.userId, input.orgId, input.repo);
  if (!access) {
    throw new GitIdentityError(
      "no_access",
      `${input.repo} isn't a project you have access to in this org, so Outrunner's GitHub App won't reach it for you. Ask an admin, ${SWITCH}.`,
      null,
    );
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

  // Never more than the member's own level on it. `review` writes to pull
  // requests (comments, but its permission also lets it close, edit and
  // approve them), so it takes write access; it never pushes.
  if (input.level === "review" && access !== "write") {
    throw new GitIdentityError(
      "no_access",
      `Reviewing ${input.repo} takes write access to it in this org, which whoever runs the automation doesn't have.`,
      null,
    );
  }
  const level: TokenLevel = input.level === "read" || input.level === "review" ? input.level : access;
  const key = `${installation.id}/${name.toLowerCase()}/${level}`;
  const kept = deps.cache.get(key);
  if (kept && kept.expiresAt.getTime() - TOKEN_MARGIN_MS > deps.now()) {
    return { identity, token: kept.token, expiresAt: kept.expiresAt };
  }
  const mint = async (fresh: boolean) =>
    deps.mint(
      config,
      installation.id,
      name,
      narrowPermissions(WANTED[level], await deps.granted(config, installation.id, fresh)),
    );
  let minted: InstallationToken;
  try {
    try {
      minted = await mint(false);
    } catch (error) {
      // A 422 may be grants since narrowed (the owner took one back): asked
      // again with them as they are now, before saying it can't be reached.
      if (!(error instanceof GitHubAppError) || error.status !== 422) throw error;
      minted = await mint(true);
    }
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
