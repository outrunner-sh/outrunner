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

/** GET a GitHub API path with the token; null on any failure. */
export async function githubGet<T>(token: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}
