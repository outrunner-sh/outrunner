/**
 * A Doppler or Infisical connection as Settings → Org → Integrations posts
 * it: read, then checked with the provider before it's kept. No Next and no
 * database: the route hands in what's stored, so a reconnect that changes
 * only the project or config needn't paste the token again.
 */

import {
  checkDoppler,
  checkInfisical,
  type DopplerCredentials,
  type InfisicalCredentials,
  infisicalSiteUrl,
  SYNC_TIMEOUT_MS,
} from "@/lib/secret-sync/providers";
import {
  dopplerTokenKind,
  type DopplerSettings,
  type InfisicalSettings,
  SecretSyncRuleError,
  slug,
} from "@/lib/secret-sync/rules";

export type Connection =
  | { provider: "doppler"; credentials: DopplerCredentials; settings: DopplerSettings; label: string }
  | { provider: "infisical"; credentials: InfisicalCredentials; settings: InfisicalSettings; label: string };

/** A secret as posted: trimmed, at most `max` characters; null for none. */
function secret(value: unknown, what: string, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SecretSyncRuleError(`${what} isn't text.`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max || /\s/.test(trimmed)) throw new SecretSyncRuleError(`That isn't ${what}.`);
  return trimmed;
}

/** The Doppler connection posted, checked with Doppler. Throws a
 *  SecretSyncRuleError for a field that can't be one, and the provider's
 *  SyncError for what it refused or couldn't answer. */
export async function acceptDoppler(
  body: Record<string, unknown>,
  stored: DopplerCredentials | null,
): Promise<Connection> {
  const token = secret(body.token, "a Doppler token") ?? stored?.token ?? null;
  if (!token) throw new SecretSyncRuleError("Paste a Doppler service token, or a personal token with its project and config.");
  const tokenKind = dopplerTokenKind(token);
  if (!tokenKind) {
    throw new SecretSyncRuleError("That isn't a Doppler token: a service token starts dp.st., a personal one dp.pt.");
  }
  const project = slug(body.project, "The Doppler project");
  const config = slug(body.config, "The Doppler config");
  const checked = await checkDoppler({ token }, tokenKind, { project, config }, AbortSignal.timeout(SYNC_TIMEOUT_MS));
  return { provider: "doppler", credentials: { token }, ...checked };
}

/** The Infisical connection posted, checked with Infisical, as
 *  {@link acceptDoppler} is. */
export async function acceptInfisical(
  body: Record<string, unknown>,
  stored: { credentials: InfisicalCredentials; siteUrl: string } | null,
): Promise<Connection> {
  const clientId = secret(body.clientId, "a client ID", 200);
  const clientSecret = secret(body.clientSecret, "a client secret");
  if ((clientId === null) !== (clientSecret === null)) {
    throw new SecretSyncRuleError("Give the machine identity's client ID and client secret together.");
  }
  const siteUrl = infisicalSiteUrl(body.siteUrl);
  if (!siteUrl) throw new SecretSyncRuleError("The site URL is your Infisical's https address, such as https://eu.infisical.com.");
  // The stored secret goes only to the site it was given for: otherwise any
  // admin could send it to a server of their own by changing the URL.
  const kept = stored && stored.siteUrl === siteUrl ? stored.credentials : null;
  const credentials = clientId && clientSecret ? { clientId, clientSecret } : kept;
  if (!credentials) {
    throw new SecretSyncRuleError(
      stored
        ? "Paste the machine identity's client ID and secret again for a new site URL."
        : "Paste the machine identity's universal auth client ID and secret.",
    );
  }
  const projectId = slug(body.projectId, "The Infisical project ID");
  const environment = slug(body.environment, "The Infisical environment");
  const checked = await checkInfisical(siteUrl, credentials, { projectId, environment }, AbortSignal.timeout(SYNC_TIMEOUT_MS));
  return { provider: "infisical", credentials, ...checked };
}
