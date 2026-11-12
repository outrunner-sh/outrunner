/** Asking Jira something with a site's token, on the server. */

import { installationById } from "@/lib/db/trackers";
import { withToken } from "@/lib/trackers/tokens";
import { tokenDeps } from "@/lib/trackers/tokens.deps";

/** An install's site never changes. */
const cloudIds = new Map<string, string>();

/**
 * A disconnected install answers `fallback`. Jira being down, or a refresh taking too
 * long, throws, for the caller to try again. See {@link withToken}.
 */
export async function askJira<T, F>(installationId: string, fallback: F, question: (token: string, cloudId: string) => Promise<T>): Promise<T | F> {
  let cloudId = cloudIds.get(installationId);
  if (!cloudId) {
    const install = await installationById(installationId);
    if (!install) return fallback;
    cloudId = install.externalId;
    cloudIds.set(installationId, cloudId);
  }
  const site = cloudId;
  return withToken(installationId, fallback, (token) => question(token, site), tokenDeps);
}
