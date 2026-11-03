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
  type GitHubRepository,
  type GitHubRepositoryList,
} from "@/lib/github/client";
import type { SourceAccount } from "@/lib/github/listing";
import { tokenPrefix } from "@/lib/github/refused";
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
  /** A token that reads `owner/name` alone, for an hour, for a box to
   *  download it with (a project's private skill registry): the App's, on
   *  the installation on its owner's account. Null where the App doesn't
   *  reach it, and always for a member's own sign-in: their token reads
   *  everything they can, and a box runs agent code, so it never gets one. */
  readToken(fullName: string): Promise<string | null>;
};

/**
 * The source for `orgId`, as `userId` (from the verified session): the App
 * when the org has kept an installation of it, else, in the user's personal
 * org, their own GitHub token (MissingGithubTokenError without one). A team
 * org reaches only what its App does: a member's own repositories never
 * land in it (GitIdentityError, to install the App, without one). Without
 * the App on this server at all, everyone's own token, as before it.
 */
export async function repositorySource(userId: string, orgId: string | undefined): Promise<SourceAccess> {
  const config = githubAppConfig();
  if (config && orgId) {
    // Only the user's own org may fall back to their own GitHub; a team's
    // can't, so its installations unread is an error, not "none".
    const personal = await isOwnPersonalOrg(orgId, userId);
    const installations = personal
      ? await listOrgInstallations(orgId).catch((error: unknown) => {
          console.error(`Repositories: couldn't read org ${orgId}'s GitHub App installations`, error);
          return [];
        })
      : await listOrgInstallations(orgId);
    if (installations.length > 0) return appSource(config, orgId, installations, userId);
    if (!personal) {
      throw new GitIdentityError(
        "no_installation",
        "This org has no GitHub App installed, so it has no repositories yet. An admin can install it in Settings → Org → GitHub.",
        "/settings/org/github",
      );
    }
  }
  const token = await requireGithubToken(userId);
  return {
    source: { kind: "user", key: `user:${userId}` },
    list: () => listGitHubRepositories(token),
    lookup: (ref) => getGitHubRepository(token, ref),
    // The member's token reads all they can: never handed to a box.
    readToken: async () => null,
  };
}

/** Read tokens of the App's, one repository each, kept until 5 minutes
 *  before they expire: every new session of a project with a private
 *  registry asks for one. */
const readTokens = new Map<string, InstallationToken>();
const READ_TOKEN_MARGIN_MS = 5 * 60 * 1000;

function appSource(config: GitHubAppConfig, orgId: string, installations: OrgInstallation[], userId: string): SourceAccess {
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
  // An App token GitHub refuses (401) is the App's, never the member's to
  // reconnect: dropped, and one minted afresh tried once more.
  const asInstallation = async <T>(installation: OrgInstallation, call: (token: string) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const token = await tokenFor(installation);
      try {
        return await call(token);
      } catch (error) {
        if (!(error instanceof GitHubReconnectError)) throw error;
        console.warn("GitHub refused a token (401)", {
          userId,
          orgId,
          route: "repositories",
          kind: "installation",
          prefix: tokenPrefix(token),
          installationId: installation.id,
          status: error.status,
          attempt,
        });
        dropInstallationToken(installation.id);
        if (attempt >= 2) {
          throw new GitHubSyncError(
            `Outrunner's GitHub App couldn't reach ${installation.accountLogin} on GitHub. Try again, or check Settings → Org → GitHub.`,
            error.status,
          );
        }
      }
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
        usable.map((installation) => asInstallation(installation, listInstallationRepositoryRecords)),
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
          const repository = await asInstallation(installation, (token) => getGitHubRepository(token, ref));
          if (repository) return repository;
        } catch (error) {
          if (error instanceof GitHubSyncError) {
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
