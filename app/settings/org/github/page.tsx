import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgGitHubSettings, type InstallationView } from "@/components/org-github";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgInstallations, listUnclaimedFor } from "@/lib/db/github-installations";
import { githubAppConfig, installationToken, listInstallationRepositories } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** How many of an installation's repositories the page names. */
const SHOWN = 12;

/**
 * Settings → Org → GitHub: the Outrunner GitHub App's installations the org
 * keeps, and the repositories each reaches. Its admins install it, and let
 * an installation go.
 */
type Query = { installed?: string; error?: string; pending?: string };

export default function OrgGitHub({ searchParams }: { searchParams: Promise<Query> }) {
  return (
    <Suspense fallback={<SettingsLoading title="GitHub" />}>
      <GitHubSection searchParams={searchParams} />
    </Suspense>
  );
}

async function GitHubSection({ searchParams }: { searchParams: Promise<Query> }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/github");
  const { installed, error, pending } = await searchParams;
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  const config = githubAppConfig();
  if (!org) {
    return (
      <section className="space-y-6">
        <PageHeader title={"GitHub"} />
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const [kept, unclaimed] = config
    ? await Promise.all([
        listOrgInstallations(org.id).catch(() => []),
        // Installed by them on GitHub, before GitHub's word reached the
        // setup route: theirs to add here.
        org.role === "admin" ? listUnclaimedFor(owner.githubId, org.id).catch(() => []) : Promise.resolve([]),
      ])
    : [[], []];
  const installations: InstallationView[] = await Promise.all(
    kept.map(async (installation) => {
      if (installation.suspended || !config) return { ...installation, repositories: [], total: 0, reachable: false };
      try {
        // A kept token, and one request for the few names shown.
        const token = await installationToken(config, installation.id);
        const { repositories, total } = await listInstallationRepositories(token, { limit: SHOWN });
        return { ...installation, repositories: repositories.map((r) => r.fullName), total, reachable: true };
      } catch (cause) {
        console.error(`Settings → GitHub: couldn't read installation ${installation.id}`, cause);
        return { ...installation, repositories: [], total: 0, reachable: false };
      }
    }),
  );
  return (
    <OrgGitHubSettings
      org={org}
      configured={config !== null}
      installations={installations}
      unclaimed={unclaimed}
      pending={pending === "1"}
      installed={installed ?? null}
      error={error ?? null}
    />
  );
}
