import { GitHubIdentitySettings } from "@/components/github-identity-settings";
import { SignInButton } from "@/components/signin-button";
import { hasGithubIdentity } from "@/lib/auth/identity";
import { getAuthUser } from "@/lib/auth/owner";
import { getGithubIdentity } from "@/lib/db/credentials";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";
export async function GitHubConnectionSection({
  userId,
  login,
}: {
  userId: string;
  login: string;
}) {
  const user = await getAuthUser();
  if (!user || !hasGithubIdentity(user))
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-medium">GitHub identity</h2>
        <p className="text-sm text-muted-foreground">
          Connect your GitHub account to work on repositories as you.
        </p>
        <SignInButton provider="github" link next="/settings/connections" />
      </div>
    );
  const appConfigured = githubAppConfig() !== null;
  const org = appConfigured
    ? (await getOrgContext().catch(() => null))?.active
    : null;
  const installations = org
    ? await listOrgInstallations(org.id).catch(() => [])
    : [];
  return (
    <div className="space-y-6">
      <GitHubIdentitySettings
        initial={await getGithubIdentity(userId).catch(() => "personal" as const)}
        login={login}
        appConfigured={appConfigured}
        org={
          org
            ? {
                name: org.name,
                admin: org.role === "admin",
                installedOn: installations
                  .filter((i) => !i.suspended)
                  .map((i) => i.accountLogin),
              }
            : null
        }
      />
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          GitHub stopped accepting your connection? Reconnect it for a fresh one, signed in to GitHub as this account.
        </p>
        <div className="max-w-xs">
          <SignInButton provider="github" reconnect next="/settings/connections" />
        </div>
      </div>
    </div>
  );
}
