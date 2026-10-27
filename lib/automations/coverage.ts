/**
 * Where the Outrunner GitHub App can post, for the automation editor's
 * repository list: read from the org's installations (Settings → Org →
 * GitHub), and for those on selected repositories, from GitHub.
 */

import { type AppCoverage, appCoverage, type AutomationRepo } from "@/lib/automations/rules";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig, installationToken, listInstallationRepositories } from "@/lib/github/app";

/** The app's coverage of each repository, by `owner/name`; empty when this
 *  deployment has no app, so nothing is flagged. */
export async function orgAppCoverage(orgId: string, repos: readonly AutomationRepo[]): Promise<Record<string, AppCoverage>> {
  const config = githubAppConfig();
  if (!config || repos.length === 0) return {};
  const installations = await listOrgInstallations(orgId);
  const selected = new Map<number, { names: Set<string>; complete: boolean }>();
  await Promise.all(
    installations
      .filter((i) => i.repositorySelection === "selected")
      .map(async (i) => {
        try {
          const { repositories, total } = await listInstallationRepositories(await installationToken(config, i.id));
          selected.set(i.id, {
            names: new Set(repositories.map((r) => r.fullName.toLowerCase())),
            complete: repositories.length >= total,
          });
        } catch (error) {
          // Left out: its repositories show as "couldn't check".
          console.error("Could not list a GitHub App installation's repositories", error);
        }
      }),
  );
  return Object.fromEntries(
    appCoverage(
      repos.map((r) => r.fullName),
      installations.map((i) => ({ ...i, installationId: i.id })),
      selected,
    ),
  );
}
