import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig, installationToken } from "@/lib/github/app";

/**
 * A token to read one of an org's repositories (`owner/name`) as the
 * Outrunner GitHub App, installed on its owner; null when the App isn't set up
 * or isn't installed there. For the Slack agent's lookups and follow-ups.
 */
export async function repoToken(orgId: string, fullName: string): Promise<string | null> {
  const config = githubAppConfig();
  if (!config) return null;
  const owner = fullName.split("/")[0]?.toLowerCase();
  const installation = (await listOrgInstallations(orgId)).find((i) => i.accountLogin.toLowerCase() === owner && !i.suspended);
  return installation ? installationToken(config, installation.id) : null;
}

export { githubGet } from "@/lib/github/rest";
