/**
 * Where an org's repositories come from, for listing and connecting them.
 *
 * A team org lists and connects the repositories its Outrunner GitHub App
 * installations reach (Settings → Org → GitHub), as the App: a team's
 * projects don't hang on any one member's GitHub, and never come from it.
 *
 * A user's personal org lists what their own GitHub connection reaches
 * (Settings → Connections → GitHub): with a personal access token they
 * pasted, every repository their account can, no App installation needed;
 * with the App's user token, the
 * repositories both they and the App's installations reach, all or the ones
 * picked on GitHub. Without one, its installations, as the App; else, while
 * those are allowed, an old sign-in token (lib/github/legacy-token.ts).
 *
 * Who clones, pushes and opens pull requests is a separate choice, the
 * member's own (lib/github/identity.ts).
 */

import { listOrgInstallations, type OrgInstallation } from "@/lib/db/github-installations";
import { GitIdentityError } from "@/lib/github/identity-error";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  dropInstallationToken,
  GitHubAppError,
  githubAppConfig,
  installationToken,
  mintInstallationToken,
  type GitHubAppConfig,
  type InstallationToken,
} from "@/lib/github/app";
import {
  getGitHubRepository,
  GitHubReconnectError,
  GitHubSyncError,
  listGitHubRepositories,
  listInstallationRepositoryRecords,
  mergeRepositoryLists,
  MissingGithubTokenError,
  type GitHubRepository,
  type GitHubRepositoryList,
} from "@/lib/github/client";
import type { SourceAccount } from "@/lib/github/listing";
import { personalCredential, type PersonalCredential } from "@/lib/github/personal";
import { pickRepositorySource } from "@/lib/github/source-choice";
import { requireGithubToken } from "@/lib/github/token";
import { listUserInstallations } from "@/lib/github/user-auth";

export type RepositorySource =
  | { kind: "app"; key: string; accounts: SourceAccount[] }
  | { kind: "user"; key: string };

/** What a source does, apart from what it is: tests pass their own. */
export type SourceAccess = {
  source: RepositorySource;
  list(): Promise<GitHubRepositoryList>;
  /** A repository by id or `owner/name`, or null when the source can't reach it. */
  lookup(ref: number | string): Promise<GitHubRepository | null>;
  /** A token that reads `owner/name` alone, for an hour, for a box to
   *  download it with (a project's private skill registry): the App's, on
   *  the installation on its owner's account. Null where the App doesn't
   *  reach it, and always for a member's own sign-in: their token reads
   *  everything they can, and a box runs agent code, so it never gets one. */
  readToken(fullName: string): Promise<string | null>;
};

/**
 * The source for `orgId`, as `userId` (from the verified session), as
 * {@link pickRepositorySource} chooses. A team org with no installation is a
 * GitIdentityError (install the App); a personal org with nothing,
 * MissingGithubTokenError. Without the App on this server at all, everyone's
 * own token, as before it.
 */
export async function repositorySource(userId: string, orgId: string | undefined): Promise<SourceAccess> {
  const config = githubAppConfig();
  if (config && orgId) {
    // Only the user's own org may use their own GitHub; a team's can't, so
    // its installations unread is an error, not "none".
    const personal = await isOwnPersonalOrg(orgId, userId);
    const installations = personal
      ? await listOrgInstallations(orgId).catch((error: unknown) => {
          console.error(`Repositories: couldn't read org ${orgId}'s GitHub App installations`, error);
          return [];
        })
      : await listOrgInstallations(orgId);
    let own: PersonalCredential | null = null;
    if (personal) {
      try {
        own = await personalCredential(userId);
      } catch (error) {
        // A connection GitHub won't renew: the org's installations still list.
        if (installations.length === 0) throw error;
        console.warn(`Repositories: user ${userId}'s GitHub connection is broken; listing their org's installations`);
      }
    }
    const choice = pickRepositorySource({ personal, installations: installations.length, own: own?.source ?? null });
    switch (choice) {
      case "no_installation":
        throw new GitIdentityError(
          "no_installation",
          "This org has no GitHub App installed, so it has no repositories yet. An admin can install it in Settings → Org → GitHub.",
          "/settings/org/github",
        );
      case "missing":
        throw new MissingGithubTokenError();
      case "app":
        return appSource(config, orgId, installations);
    }
    if (!own) throw new MissingGithubTokenError();
    if (own.source === "pat") return userSource(`pat:${userId}:${own.updatedAt}`, own.token);
    if (own.source === "app_user") return userAppSource(userId, own.token, config, orgId, installations);
    return userSource(`user:${userId}`, own.token);
  }
  return userSource(`user:${userId}`, await requireGithubToken(userId));
}

/** A user's own token, a personal access token or an old sign-in's:
 *  everything they can reach. `key` names the listing's cache entry; a
 *  personal access token's carries when it was saved, so replacing it lists
 *  afresh. */
function userSource(key: string, token: string): SourceAccess {
  return {
    source: { kind: "user", key },
    list: () => listGitHubRepositories(token),
    lookup: (ref) => getGitHubRepository(token, ref),
    // The member's token reads all they can: never handed to a box.
    readToken: async () => null,
  };
}

/**
 * A user's GitHub App user token: what both they and the App's installations
 * reach, their own account's and their GitHub organizations'. Named as the
 * App's accounts it reaches, so the picker says where to add repositories. A
 * box's read token is still one of the personal org's installations', for
 * one repository; the user's own token is never handed to one for this.
 */
async function userAppSource(
  userId: string,
  token: string,
  config: GitHubAppConfig,
  orgId: string,
  installations: OrgInstallation[],
): Promise<SourceAccess> {
  const reachable = await listUserInstallations(token).catch((error: unknown) => {
    console.warn(`Repositories: couldn't list user ${userId}'s GitHub App installations`, error instanceof Error ? error.message : error);
    return [];
  });
  const app = installations.length > 0 ? appSource(config, orgId, installations) : null;
  return {
    source:
      reachable.length > 0
        ? {
            kind: "app",
            key: `user-app:${userId}`,
            accounts: reachable.map((i) => ({
              installationId: i.id,
              login: i.accountLogin,
              type: i.accountType,
              suspended: i.suspendedAt !== null,
            })),
          }
        : { kind: "user", key: `user-app:${userId}` },
    list: () => listGitHubRepositories(token),
    lookup: (ref) => getGitHubRepository(token, ref),
    readToken: async (fullName) => (app ? app.readToken(fullName) : null),
  };
}

/** Read tokens of the App's, one repository each, kept until 5 minutes
 *  before they expire: every new session of a project with a private
 *  registry asks for one. */
const readTokens = new Map<string, InstallationToken>();
const READ_TOKEN_MARGIN_MS = 5 * 60 * 1000;

function appSource(config: GitHubAppConfig, orgId: string, installations: OrgInstallation[]): SourceAccess {
  const usable = installations.filter((i) => !i.suspended);
  const tokenFor = async (installation: OrgInstallation) => {
    try {
      return await installationToken(config, installation.id);
    } catch (error) {
      // GitHub refusing, or not reached at all (a timeout, the network):
      // either way this installation's, for the others to be tried.
      console.error(`GitHub App: no token for installation ${installation.id}`, error);
      throw new GitHubSyncError(
        `Outrunner's GitHub App couldn't reach ${installation.accountLogin} on GitHub. Try again, or check Settings → Org → GitHub.`,
        error instanceof GitHubAppError ? error.status : undefined,
      );
    }
  };
  return {
    source: {
      kind: "app",
      key: `app:${orgId}`,
      accounts: installations.map((i) => ({
        installationId: i.id,
        login: i.accountLogin,
        type: i.accountType,
        suspended: i.suspended,
      })),
    },
    async list() {
      // What can be read, when one installation can't be: the list says it
      // may be missing some.
      const settled = await Promise.allSettled(
        usable.map(async (installation) => listInstallationRepositoryRecords(await tokenFor(installation))),
      );
      const lists = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
      if (failed.length > 0 && lists.length === 0) throw failed[0];
      for (const reason of failed) console.error("GitHub App: an installation's repositories couldn't be listed", reason);
      const merged = mergeRepositoryLists(lists);
      return { ...merged, complete: merged.complete && failed.length === 0 };
    },
    async lookup(ref) {
      // By name, the installation on its owner's account first; then the
      // rest, for a name from before a transfer or a rename, which GitHub
      // still answers. By id, whichever reaches it (one per account).
      const owner = typeof ref === "string" ? ref.split("/")[0]?.toLowerCase() : undefined;
      const candidates = [
        ...usable.filter((i) => i.accountLogin.toLowerCase() === owner),
        ...usable.filter((i) => i.accountLogin.toLowerCase() !== owner),
      ];
      // One installation failing doesn't stop the others being asked; with
      // none finding it, the first failure is said rather than "can't see it".
      let failure: unknown;
      for (const installation of candidates) {
        try {
          const repository = await getGitHubRepository(await tokenFor(installation), ref);
          if (repository) return repository;
        } catch (error) {
          if (error instanceof GitHubReconnectError) {
            // The App's token refused: one kept for an installation gone
            // since, nothing the member's own sign-in would fix.
            dropInstallationToken(installation.id);
            failure ??= new GitHubSyncError(
              `Outrunner's GitHub App couldn't reach ${installation.accountLogin} on GitHub. Try again, or check Settings → Org → GitHub.`,
              error.status,
            );
          } else if (error instanceof GitHubSyncError) {
            failure ??= error;
          } else {
            throw error;
          }
        }
      }
      if (failure) throw failure;
      return null;
    },
    async readToken(fullName) {
      const [owner, name] = fullName.split("/");
      const installation = usable.find((i) => i.accountLogin.toLowerCase() === owner?.toLowerCase());
      if (!installation || !name) return null;
      const key = `${installation.id}/${name.toLowerCase()}`;
      const kept = readTokens.get(key);
      if (kept && kept.expiresAt.getTime() - READ_TOKEN_MARGIN_MS > Date.now()) return kept.token;
      try {
        const minted = await mintInstallationToken(config, installation.id, [name], fetch, { contents: "read", metadata: "read" });
        readTokens.set(key, minted);
        return minted.token;
      } catch (error) {
        // Not one of the repositories its owner let the App reach.
        if (error instanceof GitHubAppError && (error.status === 422 || error.status === 404)) return null;
        throw error;
      }
    },
  };
}

/** Whether the org is `userId`'s own personal org. Throws when that can't be
 *  read: guessing personal would list a member's own repositories for a team. */
async function isOwnPersonalOrg(orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .select("personal_owner_id")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data?.personal_owner_id === userId;
}
