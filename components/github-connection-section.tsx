import { GitHubConnectionCard, type GitHubCardView } from "@/components/github-connection-card";
import { GitHubIdentitySettings } from "@/components/github-identity-settings";
import { SignInButton } from "@/components/signin-button";
import { hasGithubIdentity } from "@/lib/auth/identity";
import { getAuthUser } from "@/lib/auth/owner";
import { credentialStatus, getGithubIdentity } from "@/lib/db/credentials";
import { githubConnectionStatus } from "@/lib/db/github-connections";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import { githubSignInScopes, legacyTokenMode } from "@/lib/github/legacy-token";
import { installationSettingsUrl } from "@/lib/github/listing";
import { listUserInstallations } from "@/lib/github/user-auth";
import { githubUserToken, userAuthConfigured } from "@/lib/github/user-connection.deps";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * Settings → Connections → GitHub: the user's own GitHub connection for
 * their repositories (the Outrunner GitHub App's user authorization,
 * lib/github/user-auth.ts), what it reaches, and how it's doing, with
 * Connect, Manage repositories, Reconnect and Disconnect in place (never a
 * sign-out); then who their sessions work on GitHub as.
 */
export async function GitHubConnectionSection({
  userId,
  login,
  result,
}: {
  userId: string;
  login: string;
  /** How the last connect ended (`?github=`). */
  result: string | null;
}) {
  const configured = userAuthConfigured();
  const mode = legacyTokenMode();
  const [connection, credentials] = await Promise.all([
    githubConnectionStatus(userId).catch((error: unknown) => {
      console.error("Settings: could not read the GitHub connection", error);
      return null;
    }),
    credentialStatus(userId).catch(() => null),
  ]);

  // What the connection reaches, from GitHub: its installations, live.
  let installations: GitHubCardView["installations"] = null;
  if (connection && !connection.broken) {
    try {
      const token = await githubUserToken(userId);
      if (token) {
        installations = (await listUserInstallations(token.token)).map((i) => ({
          login: i.accountLogin,
          type: i.accountType,
          own: i.accountType === "User" && i.accountId === connection.githubUserId,
          selection: i.repositorySelection,
          suspended: i.suspendedAt !== null,
          manageUrl: installationSettingsUrl({ installationId: i.id, login: i.accountLogin, type: i.accountType }),
        }));
      }
    } catch (error) {
      console.warn("Settings: couldn't list the GitHub connection's installations", error instanceof Error ? error.message : error);
    }
  }

  const view: GitHubCardView = {
    configured,
    signInLogin: login || null,
    connection: connection && {
      login: connection.login,
      broken: connection.broken,
      accessExpiresAt: connection.accessExpiresAt,
      refreshExpiresAt: connection.refreshExpiresAt,
      updatedAt: connection.updatedAt,
    },
    installations,
    legacy: credentials?.github.connected ? { login: credentials.github.login, updatedAt: credentials.github.updatedAt } : null,
    mode,
    result,
  };

  // Sign-in still keeps a `repo` token here (GITHUB_LEGACY_TOKENS=store):
  // connecting GitHub is linking it to the account, as before.
  const user = mode === "store" && !configured ? await getAuthUser() : null;
  const linkInstead = user !== null && !hasGithubIdentity(user);

  const appConfigured = githubAppConfig() !== null;
  const org = appConfigured ? (await getOrgContext().catch(() => null))?.active : null;
  const orgInstallations = org ? await listOrgInstallations(org.id).catch(() => []) : [];
  return (
    <div className="space-y-6">
      <GitHubConnectionCard view={view}>
        {linkInstead && (
          <div className="max-w-xs">
            <SignInButton provider="github" link next="/settings/connections" githubScopes={githubSignInScopes()} />
          </div>
        )}
      </GitHubConnectionCard>
      <GitHubIdentitySettings
        initial={await getGithubIdentity(userId).catch(() => "personal" as const)}
        login={connection?.login ?? login}
        appConfigured={appConfigured}
        org={
          org
            ? {
                name: org.name,
                admin: org.role === "admin",
                installedOn: orgInstallations.filter((i) => !i.suspended).map((i) => i.accountLogin),
              }
            : null
        }
      />
    </div>
  );
}
