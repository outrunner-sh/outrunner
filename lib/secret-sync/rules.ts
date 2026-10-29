/**
 * The rules of Doppler and Infisical secret sync (docs/secret-sync.md): what
 * an org's connection and a project's link hold, how a link's target reads,
 * and how synced secrets join a session's environment beside the project's
 * own variables.
 *
 * Pure (no Node, no database), so the page shows what the server does and
 * both are unit-tested.
 */

import { envBytes, MAX_ENV_BYTES } from "@/lib/environments/rules";
import { settableEnv } from "@/lib/imports/settable-env";

export const SECRET_PROVIDERS = ["doppler", "infisical"] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export function isSecretProvider(value: unknown): value is SecretProvider {
  return value === "doppler" || value === "infisical";
}

export const PROVIDER_LABELS: Record<SecretProvider, string> = { doppler: "Doppler", infisical: "Infisical" };

/** Infisical's US cloud, where a site URL left blank points. */
export const INFISICAL_CLOUD = "https://app.infisical.com";

/** What a Doppler connection keeps unsealed: which kind of token it is, and
 *  for a token that isn't tied to one config (a personal or service account
 *  token), the project and config a link uses unless it names its own. A
 *  service token reads only its own config, named here as Doppler said. */
export type DopplerSettings = { tokenKind: "service" | "account"; project: string | null; config: string | null };

/** What an Infisical connection keeps unsealed: its site, and the project
 *  and environment a link uses unless it names its own. */
export type InfisicalSettings = { siteUrl: string; projectId: string | null; environment: string | null };

/** Where a project's link reads from, over its connection's own. */
export type DopplerLink = { project: string | null; config: string | null };
export type InfisicalLink = {
  projectId: string | null;
  environment: string | null;
  path: string | null;
  /** Whether sessions get the `infisical` CLI signed in. Off unless an admin
   *  turns it on: the access token reads whatever the machine identity can,
   *  not only this link's folder. */
  cli?: boolean;
};

/** The kind of a Doppler token, from its prefix: a service token (dp.st.)
 *  reads one config; a personal (dp.pt.), service account (dp.sa.) or CLI
 *  (dp.ct.) token is told which. Null for anything else. */
export function dopplerTokenKind(token: string): DopplerSettings["tokenKind"] | null {
  if (!/^dp\.[a-z]+\.[A-Za-z0-9._-]{8,}$/.test(token)) return null;
  if (token.startsWith("dp.st.")) return "service";
  if (token.startsWith("dp.pt.") || token.startsWith("dp.sa.") || token.startsWith("dp.ct.")) return "account";
  return null;
}

/** A refused connection or link; its message is a sentence for the page. */
export class SecretSyncRuleError extends Error {}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** A slug as posted (a Doppler project or config, an Infisical project id or
 *  environment), trimmed; null for none; refused when it can't be one. */
export function slug(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SecretSyncRuleError(`${what} isn't text.`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!SLUG.test(trimmed)) throw new SecretSyncRuleError(`${what} can hold only letters, digits, dots, dashes and underscores.`);
  return trimmed;
}

/** An Infisical folder as posted: "/" or "/a/b", no trailing slash; null for
 *  none (the root). */
export function secretPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SecretSyncRuleError("The secret path isn't text.");
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (path.length > 256 || !path.slice(1).split("/").every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) {
    throw new SecretSyncRuleError("The secret path is a folder like /apps/api.");
  }
  return path;
}

/** Doppler's project and config for a link: its own, else its connection's. */
export function dopplerTarget(settings: DopplerSettings, link: DopplerLink): { project: string | null; config: string | null } {
  // A service token reads its own config whatever a link says.
  if (settings.tokenKind === "service") return { project: settings.project, config: settings.config };
  return { project: link.project ?? settings.project, config: link.config ?? settings.config };
}

/** Infisical's project, environment and folder for a link: its own, else its
 *  connection's, the root folder when none is named. */
export function infisicalTarget(
  settings: InfisicalSettings,
  link: InfisicalLink,
): { projectId: string | null; environment: string | null; path: string } {
  return {
    projectId: link.projectId ?? settings.projectId,
    environment: link.environment ?? settings.environment,
    path: link.path ?? "/",
  };
}

/** A link's target as the page writes it: "backend / prd",
 *  "6f1c… · staging · /api". */
export function describeTarget(
  provider: SecretProvider,
  settings: DopplerSettings | InfisicalSettings,
  link: DopplerLink | InfisicalLink,
): string {
  if (provider === "doppler") {
    const t = dopplerTarget(settings as DopplerSettings, link as DopplerLink);
    if ((settings as DopplerSettings).tokenKind === "service" && !(t.project && t.config)) return "the service token's config";
    return `${t.project ?? "?"} / ${t.config ?? "?"}`;
  }
  const t = infisicalTarget(settings as InfisicalSettings, link as InfisicalLink);
  return `${t.projectId ?? "?"} · ${t.environment ?? "?"} · ${t.path}`;
}

/** Secrets one provider gave, for {@link mergeSyncedEnv}. */
export type SyncedSecrets = { provider: SecretProvider; env: Record<string, string> };

/** What became of each provider's secrets in a session's environment. */
export type MergeOutcome = {
  /** Names it set (some perhaps then replaced by a later source). */
  names: string[];
  /** Names a session can't take (PATH, RUNTIME_…, a value with a NUL). */
  skipped: string[];
  /** Its secrets were left out whole: with them the environment is larger
   *  than a session takes. */
  tooLarge: boolean;
};

/**
 * A session's variables: each provider's secrets in the order given (a later
 * one winning a name), then the project's own, which win over all of them.
 * A name a session can't set is skipped, as a project's own would be refused.
 * Should the whole be larger than a session takes, the last provider's
 * secrets are left out, then the one before, rather than the session's agent
 * refusing the lot.
 */
export function mergeSyncedEnv(
  own: Record<string, string>,
  synced: readonly SyncedSecrets[],
): { env: Record<string, string>; outcomes: Map<SecretProvider, MergeOutcome> } {
  const outcomes = new Map<SecretProvider, MergeOutcome>();
  const usable = synced.map(({ provider, env }) => {
    const kept: Record<string, string> = {};
    const skipped: string[] = [];
    for (const [name, value] of Object.entries(env)) {
      // `__proto__` passes settableEnv, but assigning it on a plain object
      // sets a prototype instead of the key: the secret is lost without a
      // trace, so count it as skipped.
      if (name === "__proto__" || !settableEnv(name) || typeof value !== "string" || value.includes("\0")) skipped.push(name);
      else kept[name] = value;
    }
    outcomes.set(provider, { names: Object.keys(kept).sort(), skipped: skipped.sort(), tooLarge: false });
    return { provider, env: kept };
  });
  let included = usable;
  for (;;) {
    const env = Object.assign({}, ...included.map((s) => s.env), own) as Record<string, string>;
    if (envBytes(env) <= MAX_ENV_BYTES || included.length === 0) return { env, outcomes };
    const dropped = included[included.length - 1];
    outcomes.set(dropped.provider, { ...outcomes.get(dropped.provider)!, tooLarge: true });
    included = included.slice(0, -1);
  }
}

/** Where a variable a new session gets comes from, for the page: the
 *  project's own, or a provider's; and, for a synced one, what it loses to
 *  when another source has it too. */
export type VariableSource = {
  name: string;
  source: "project" | SecretProvider;
  /** The source whose value the session gets instead. */
  shadowedBy: "project" | SecretProvider | null;
};

/** Every variable a new session would get, by source, from the project's own
 *  names and each provider's names at its last sync, in the order
 *  {@link mergeSyncedEnv} applies them. Sorted by name, the project's first. */
export function variableSources(
  ownNames: readonly string[],
  synced: ReadonlyArray<{ provider: SecretProvider; names: readonly string[] }>,
): VariableSource[] {
  const own = new Set(ownNames);
  const rows: VariableSource[] = ownNames.map((name) => ({ name, source: "project", shadowedBy: null }));
  synced.forEach(({ provider, names }, i) => {
    for (const name of names) {
      const later = synced.slice(i + 1).find((s) => s.names.includes(name));
      rows.push({ name, source: provider, shadowedBy: own.has(name) ? "project" : (later?.provider ?? null) });
    }
  });
  const rank = (r: VariableSource) => (r.source === "project" ? 0 : 1 + SECRET_PROVIDERS.indexOf(r.source));
  return rows.sort((a, b) => a.name.localeCompare(b.name) || rank(a) - rank(b));
}

/** The order providers' secrets are applied in: Infisical's over Doppler's. */
export function syncOrder<T extends { provider: SecretProvider }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => SECRET_PROVIDERS.indexOf(a.provider) - SECRET_PROVIDERS.indexOf(b.provider));
}

/** How long a link's sync stands before the page may test it again: each
 *  test is a login and a read with the org's credentials, and the providers
 *  rate-limit per token, so a burst of tests could fail real sessions. */
export const TEST_SYNC_COOLDOWN_MS = 10_000;

/** Milliseconds until a link last synced at `lastSyncedAt` may be tested
 *  again; 0 when it may be now. */
export function testSyncWait(lastSyncedAt: string | null | undefined, now = Date.now()): number {
  const at = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at + TEST_SYNC_COOLDOWN_MS - now);
}
