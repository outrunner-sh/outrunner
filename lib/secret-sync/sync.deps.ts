/**
 * Real wiring for secret sync (lib/secret-sync/sync.ts): a project's links
 * and their connections' credentials from the database, their secrets from
 * the providers, and each sync's outcome recorded on its link. Kept apart so
 * the rules stay free of the database and unit-testable.
 */

import { recordSync, type SyncLink, syncLinks } from "@/lib/db/secret-sync";
import { linkSecrets, SyncError } from "@/lib/secret-sync/providers";
import { PROVIDER_LABELS } from "@/lib/secret-sync/rules";
import { type SyncResult, syncSecrets } from "@/lib/secret-sync/sync";

/** The project's variables and start hook for a session starting now, with
 *  its linked secrets fetched. Never throws. */
export function syncEnvironmentSecrets(
  environmentId: string,
  own: { env: Record<string, string>; startHook: string | null },
): Promise<SyncResult> {
  return syncSecrets<SyncLink>(
    {
      links: () => syncLinks(environmentId),
      fetch: async (link, signal) => {
        if (!link.credentials) {
          throw new SyncError(`The org's ${PROVIDER_LABELS[link.provider]} credentials can't be opened. Reconnect it.`, true);
        }
        return link.provider === "doppler"
          ? linkSecrets({ ...link, credentials: link.credentials }, signal)
          : linkSecrets({ ...link, credentials: link.credentials }, signal);
      },
      record: (provider, result) => recordSync(environmentId, provider, result),
    },
    own,
  );
}
