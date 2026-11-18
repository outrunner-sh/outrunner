/** syncInstallationProjects (lib/github/connect-installation.ts) wired to
 *  GitHub, as the App, and the database, as the signed-in user. */

import { upsertProjects } from "@/lib/db/repositories";
import { githubAppConfig, installationToken } from "@/lib/github/app";
import { listInstallationRepositoryRecords } from "@/lib/github/client";
import { syncInstallationProjects } from "@/lib/github/connect-installation";

/** The installation's repositories, now the org's projects: how many, or
 *  null when they couldn't be added (Sync repositories tries again). */
export function syncConnectedInstallation(ownerId: string, orgId: string, installationId: number): Promise<number | null> {
  return syncInstallationProjects({ ownerId, orgId, installationId }, {
    list: async (id) => {
      const config = githubAppConfig();
      if (!config) throw new Error("The GitHub App isn't configured.");
      return (await listInstallationRepositoryRecords(await installationToken(config, id))).repositories;
    },
    upsert: upsertProjects,
  });
}
