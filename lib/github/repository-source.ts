/**
 * Where an org's repositories come from, for listing and connecting them.
 *
 * An org with the Outrunner GitHub App installed (Settings → Org → GitHub)
 * lists and connects the repositories its installations reach, as the App:
 * a team's projects don't hang on any one member's GitHub. An org without it
 * (a personal org, most often) uses the member's own GitHub sign-in, as
 * before.
 *
 * Who clones, pushes and opens pull requests is a separate choice, the
 * member's own (lib/github/identity.ts, to come).
 */

import { listOrgInstallations, type OrgInstallation } from "@/lib/db/github-installations";
import {
  dropInstallationToken,
  GitHubAppError,
  githubAppConfig,
  installationToken,
  type GitHubAppConfig,
} from "@/lib/github/app";
import {
  getGitHubRepository,
  GitHubReconnectError,
  GitHubSyncError,
  listGitHubRepositories,
  listInstallationRepositoryRecords,
  mergeRepositoryLists,
  type GitHubRepository,
  type GitHubRepositoryList,
} from "@/lib/github/client";
import type { SourceAccount } from "@/lib/github/listing";
import { requireGithubToken } from "@/lib/github/token";

export type RepositorySource =
  | { kind: "app"; key: string; accounts: SourceAccount[] }
  | { kind: "user"; key: string };

/** What a source does, apart from what it is: tests pass their own. */
export type SourceAccess = {
  source: RepositorySource;
  list(): Promise<GitHubRepositoryList>;
  /** A repository by id or `owner/name`, or null when the source can't reach it. */
  lookup(ref: number | string): Promise<GitHubRepository | null>;
};

/**
 * The source for `orgId`, as `userId` (from the verified session): the App
 * when the org has kept an installation of it, else the user's own GitHub
 * token (MissingGithubTokenError without one).
 */
export async function repositorySource(userId: string, orgId: string | undefined): Promise<SourceAccess> {
  const config = githubAppConfig();
  // The App's installations unread is no reason to stop anyone picking a
  // repository: the user's own GitHub, as before the App.
  const installations =
    config && orgId
      ? await listOrgInstallations(orgId).catch((error: unknown) => {
          console.error(`Repositories: couldn't read org ${orgId}'s GitHub App installations`, error);
          return [];
        })
      : [];
  if (config && orgId && installations.length > 0) return appSource(config, orgId, installations);
  const token = await requireGithubToken(userId);
  return {
    source: { kind: "user", key: `user:${userId}` },
    list: () => listGitHubRepositories(token),
    lookup: (ref) => getGitHubRepository(token, ref),
  };
}

function appSource(config: GitHubAppConfig, orgId: string, installations: OrgInstallation[]): SourceAccess {
  const usable = installations.filter((i) => !i.suspended);
  const tokenFor = async (installation: OrgInstallation) => {
    try {
      return await installationToken(config, installation.id);
    } catch (error) {
      if (!(error instanceof GitHubAppError)) throw error;
      console.error(`GitHub App: no token for installation ${installation.id}`, error);
      throw new GitHubSyncError(
        `Outrunner's GitHub App couldn't reach ${installation.accountLogin} on GitHub. Try again, or check Settings → Org → GitHub.`,
        error.status,
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
      for (const installation of candidates) {
        let repository: GitHubRepository | null;
        try {
          repository = await getGitHubRepository(await tokenFor(installation), ref);
        } catch (error) {
          // The App's token refused: one kept for an installation gone since,
          // nothing the member's own sign-in would fix.
          if (!(error instanceof GitHubReconnectError)) throw error;
          dropInstallationToken(installation.id);
          throw new GitHubSyncError(
            `Outrunner's GitHub App couldn't reach ${installation.accountLogin} on GitHub. Try again, or check Settings → Org → GitHub.`,
            error.status,
          );
        }
        if (repository) return repository;
      }
      return null;
    },
  };
}
