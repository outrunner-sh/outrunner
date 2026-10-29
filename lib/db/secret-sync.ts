/**
 * An org's Doppler and Infisical connections, and the projects linked to
 * them (20261103140000_secret_sync.sql; docs/secret-sync.md).
 *
 * A connection's credentials are sealed (lib/crypto/secret-box.ts) and never
 * leave the server: what the pages get is what each is connected to and
 * where each link reads from. Connecting, and linking a project, are an org
 * admin's: a link hands whatever its connection reads to every session of
 * the project, so it's the admin who decides which project gets which
 * config, not whoever can change the project. Service role only.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { environmentLevel } from "@/lib/db/org-access";
import { memberRole } from "@/lib/db/orgs";
import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { DopplerCredentials, InfisicalCredentials } from "@/lib/secret-sync/providers";
import {
  type DopplerLink,
  type DopplerSettings,
  type InfisicalLink,
  type InfisicalSettings,
  INFISICAL_CLOUD,
  SecretSyncRuleError,
  type SecretProvider,
  syncOrder,
} from "@/lib/secret-sync/rules";
import type { SyncOutcome } from "@/lib/secret-sync/sync";
import { probeStatus } from "@/lib/supabase/probe";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A connection as the pages show it: never its credentials. */
export type IntegrationStatus =
  | { provider: "doppler"; label: string; settings: DopplerSettings; updatedAt: string; links: number }
  | { provider: "infisical"; label: string; settings: InfisicalSettings; updatedAt: string; links: number };

export type OrgSecretIntegrations = { doppler: IntegrationStatus | null; infisical: IntegrationStatus | null };

/** A project's link as its page shows it, with its last sync. */
export type LinkView = {
  provider: SecretProvider;
  link: DopplerLink | InfisicalLink;
  lastSync: { at: string; error: string | null; warning: string | null; names: string[]; skipped: string[] } | null;
};

/** What a project's page shows of secret sync: the org's connections, which
 *  of them the project reads, and whether the user may change that. */
export type EnvironmentSecretSync = {
  integrations: OrgSecretIntegrations;
  links: LinkView[];
  /** An admin of the project's org: may link and unlink it. */
  canLink: boolean;
  /** May ask for a sync now (write on the project). */
  canTest: boolean;
};

/** Before the migration, no org has a connection. */
function beforeSecretSync(error: { code?: string }): boolean {
  return probeStatus(error) === "missing";
}

export function dopplerSettingsOf(value: Json): DopplerSettings {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, Json>;
  return {
    tokenKind: v.tokenKind === "account" ? "account" : "service",
    project: typeof v.project === "string" ? v.project : null,
    config: typeof v.config === "string" ? v.config : null,
  };
}

export function infisicalSettingsOf(value: Json): InfisicalSettings {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, Json>;
  return {
    siteUrl: typeof v.siteUrl === "string" ? v.siteUrl : INFISICAL_CLOUD,
    projectId: typeof v.projectId === "string" ? v.projectId : null,
    environment: typeof v.environment === "string" ? v.environment : null,
  };
}

function linkOf(provider: SecretProvider, value: Json): DopplerLink | InfisicalLink {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, Json>;
  const text = (x: Json | undefined) => (typeof x === "string" ? x : null);
  return provider === "doppler"
    ? { project: text(v.project), config: text(v.config) }
    : { projectId: text(v.projectId), environment: text(v.environment), path: text(v.path), cli: v.cli === true };
}

/** The org's connections, and how many projects each is linked to. */
export async function orgSecretIntegrations(orgId: string): Promise<OrgSecretIntegrations> {
  const none: OrgSecretIntegrations = { doppler: null, infisical: null };
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("org_secret_integrations")
    .select("id, provider, label, settings, updated_at")
    .eq("org_id", orgId);
  if (error && beforeSecretSync(error)) return none;
  if (error) throw error;
  if (data.length === 0) return none;
  const { data: links, error: linksError } = await supabase
    .from("environment_secret_links")
    .select("integration_id")
    .eq("org_id", orgId);
  if (linksError) throw linksError;
  const counts = new Map<string, number>();
  for (const l of links) counts.set(l.integration_id, (counts.get(l.integration_id) ?? 0) + 1);
  for (const row of data) {
    const base = { label: row.label, updatedAt: row.updated_at, links: counts.get(row.id) ?? 0 };
    if (row.provider === "doppler") none.doppler = { provider: "doppler", settings: dopplerSettingsOf(row.settings), ...base };
    else none.infisical = { provider: "infisical", settings: infisicalSettingsOf(row.settings), ...base };
  }
  return none;
}

/** The org's stored credentials for `provider`, opened: for a reconnect that
 *  changes only the project or config. Null for none, or one that no
 *  longer opens. */
export async function storedCredentials(orgId: string, provider: "doppler"): Promise<DopplerCredentials | null>;
export async function storedCredentials(orgId: string, provider: "infisical"): Promise<InfisicalCredentials | null>;
export async function storedCredentials(orgId: string, provider: SecretProvider): Promise<object | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("org_secret_integrations")
    .select("credentials_ciphertext")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error && beforeSecretSync(error)) return null;
  if (error) throw error;
  if (!data) return null;
  try {
    return JSON.parse(open(data.credentials_ciphertext)) as object;
  } catch {
    return null;
  }
}

/** Keep the org's connection to `provider`, checked with it already, as
 *  admin `by`. Its links stay linked: a new token for the same thing. */
export async function saveOrgSecretIntegration(
  orgId: string,
  connection:
    | { provider: "doppler"; credentials: DopplerCredentials; settings: DopplerSettings; label: string }
    | { provider: "infisical"; credentials: InfisicalCredentials; settings: InfisicalSettings; label: string },
  by: string,
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("org_secret_integrations")
    .upsert(
      {
        org_id: orgId,
        provider: connection.provider,
        credentials_ciphertext: seal(JSON.stringify(connection.credentials)),
        settings: connection.settings as unknown as Json,
        label: connection.label.slice(0, 200),
        connected_by: by,
      },
      { onConflict: "org_id,provider" },
    );
  if (error) throw error;
}

/** Forget the org's connection to `provider`, and unlink every project from
 *  it (on delete cascade). How many projects were linked. */
export async function removeOrgSecretIntegration(orgId: string, provider: SecretProvider): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const { count, error: countError } = await supabase
    .from("environment_secret_links")
    .select("environment_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (countError) throw countError;
  const { error } = await supabase.from("org_secret_integrations").delete().eq("org_id", orgId).eq("provider", provider);
  if (error) throw error;
  return count ?? 0;
}

/** The project's org, or null for no project. */
async function environmentOrg(environmentId: string): Promise<{ orgId: string; name: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("org_id, name")
    .eq("id", environmentId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw error;
  return data?.org_id ? { orgId: data.org_id, name: data.name } : null;
}

/** The project's secret sync for its page; null when the user can't read
 *  the project. */
export async function environmentSecretSync(userId: string, environmentId: string): Promise<EnvironmentSecretSync | null> {
  const access: AccessLevel | null = await environmentLevel(userId, environmentId);
  if (!access) return null;
  const env = await environmentOrg(environmentId);
  if (!env) return null;
  const [integrations, role, links] = await Promise.all([
    orgSecretIntegrations(env.orgId),
    memberRole(env.orgId, userId),
    environmentLinks(environmentId),
  ]);
  return { integrations, links, canLink: role === "admin", canTest: allows(access, "write") };
}

async function environmentLinks(environmentId: string): Promise<LinkView[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_secret_links")
    .select("provider, settings, last_synced_at, last_error, last_warning, last_names, last_skipped")
    .eq("environment_id", environmentId);
  if (error && beforeSecretSync(error)) return [];
  if (error) throw error;
  return syncOrder(data).map((row) => ({
    provider: row.provider,
    link: linkOf(row.provider, row.settings),
    lastSync: row.last_synced_at
      ? {
          at: row.last_synced_at,
          error: row.last_error,
          warning: row.last_warning,
          names: row.last_names,
          skipped: row.last_skipped,
        }
      : null,
  }));
}

/** Only an admin of the project's org links it, or unlinks it. */
export class SecretSyncAccessError extends Error {
  constructor() {
    super("Only an admin of this project's org can link it to Doppler or Infisical.");
    this.name = "SecretSyncAccessError";
  }
}

/** The project's org, when `userId` is its admin; else SecretSyncAccessError
 *  (or null for a project they can't see at all). */
async function adminOfEnvironment(userId: string, environmentId: string): Promise<{ orgId: string; name: string } | null> {
  if (!(await environmentLevel(userId, environmentId))) return null;
  const env = await environmentOrg(environmentId);
  if (!env) return null;
  if ((await memberRole(env.orgId, userId)) !== "admin") throw new SecretSyncAccessError();
  return env;
}

/** Link the project to its org's `provider` connection, reading `link`
 *  (over the connection's own), replacing any link it had to it. The
 *  project's name, for the audit log; null when the user can't see it. */
export async function linkEnvironment(
  userId: string,
  environmentId: string,
  provider: SecretProvider,
  link: DopplerLink | InfisicalLink,
): Promise<{ orgId: string; name: string } | null> {
  const env = await adminOfEnvironment(userId, environmentId);
  if (!env) return null;
  const supabase = createSupabaseAdminClient();
  const { data: integration, error } = await supabase
    .from("org_secret_integrations")
    .select("id")
    .eq("org_id", env.orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  if (!integration) throw new SecretSyncRuleError("Connect it under Settings → Org → Integrations first.");
  const { error: upsertError } = await supabase.from("environment_secret_links").upsert(
    {
      environment_id: environmentId,
      integration_id: integration.id,
      org_id: env.orgId,
      provider,
      settings: link as unknown as Json,
      linked_by: userId,
      // A new target's last sync was of the old one.
      last_synced_at: null,
      last_error: null,
      last_warning: null,
      last_names: [],
      last_skipped: [],
    },
    { onConflict: "environment_id,provider" },
  );
  if (upsertError) throw upsertError;
  return env;
}

/** Unlink the project from `provider`. The project's name, as for
 *  {@link linkEnvironment}. */
export async function unlinkEnvironment(
  userId: string,
  environmentId: string,
  provider: SecretProvider,
): Promise<{ orgId: string; name: string } | null> {
  const env = await adminOfEnvironment(userId, environmentId);
  if (!env) return null;
  const { error } = await createSupabaseAdminClient()
    .from("environment_secret_links")
    .delete()
    .eq("environment_id", environmentId)
    .eq("provider", provider);
  if (error) throw error;
  return env;
}

/** A link as a sync needs it: its connection's credentials opened, or why
 *  they couldn't be. */
export type SyncLink =
  | { provider: "doppler"; credentials: DopplerCredentials | null; settings: DopplerSettings; link: DopplerLink }
  | { provider: "infisical"; credentials: InfisicalCredentials | null; settings: InfisicalSettings; link: InfisicalLink };

/** The project's links (or only its `only` one), Doppler's first, for a session starting (whose
 *  user's access to the project was checked as its setup was read) or a
 *  test from the page. Credentials that no longer open (a rotated
 *  CREDENTIALS_ENCRYPTION_KEY) come as null, for the sync to say so. */
export async function syncLinks(environmentId: string, only?: SecretProvider): Promise<SyncLink[]> {
  const supabase = createSupabaseAdminClient();
  let query = supabase.from("environment_secret_links").select("provider, integration_id, settings").eq("environment_id", environmentId);
  if (only) query = query.eq("provider", only);
  const { data: links, error } = await query;
  if (error && beforeSecretSync(error)) return [];
  if (error) throw error;
  if (links.length === 0) return [];
  const { data: integrations, error: integrationsError } = await supabase
    .from("org_secret_integrations")
    .select("id, provider, credentials_ciphertext, settings")
    .in(
      "id",
      links.map((l) => l.integration_id),
    );
  if (integrationsError) throw integrationsError;
  const byId = new Map(integrations.map((i) => [i.id, i]));
  return syncOrder(links).flatMap((l): SyncLink[] => {
    const integration = byId.get(l.integration_id);
    if (!integration) return [];
    let credentials: object | null = null;
    try {
      credentials = JSON.parse(open(integration.credentials_ciphertext)) as object;
    } catch {
      console.error(`The org's ${l.provider} credentials can't be opened`);
    }
    if (l.provider === "doppler") {
      return [
        {
          provider: "doppler",
          credentials: credentials as DopplerCredentials | null,
          settings: dopplerSettingsOf(integration.settings),
          link: linkOf("doppler", l.settings) as DopplerLink,
        },
      ];
    }
    return [
      {
        provider: "infisical",
        credentials: credentials as InfisicalCredentials | null,
        settings: infisicalSettingsOf(integration.settings),
        link: linkOf("infisical", l.settings) as InfisicalLink,
      },
    ];
  });
}

/** Record a link's sync: when, its error or warning (a sentence, never a
 *  value) and the names it brought. */
export async function recordSync(
  environmentId: string,
  provider: SecretProvider,
  result: SyncOutcome,
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("environment_secret_links")
    .update({
      last_synced_at: new Date().toISOString(),
      last_error: result.error?.slice(0, 500) ?? null,
      last_warning: result.warning?.slice(0, 500) ?? null,
      last_names: result.names,
      last_skipped: result.skipped,
    })
    .eq("environment_id", environmentId)
    .eq("provider", provider);
  if (error) throw error;
}
