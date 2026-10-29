/**
 * Asking Doppler and Infisical for a config's secrets, and whether they take
 * a connection's credentials. Only `fetch`: no Next, no database, so it tests
 * with a stubbed fetch.
 *
 * A failure is a {@link SyncError} whose message is a sentence for the
 * project's page. It never holds a response body: a provider's error could
 * echo what it was sent, and a body that did parse holds the secrets.
 */

import { webhookUrl } from "@/lib/api/webhooks";
import {
  dopplerTarget,
  INFISICAL_CLOUD,
  infisicalTarget,
  type DopplerLink,
  type DopplerSettings,
  type InfisicalLink,
  type InfisicalSettings,
} from "@/lib/secret-sync/rules";

/** As long as a provider has to answer, login and secrets together: a
 *  session waits on this as it starts, so an outage costs it this, not a
 *  hung start. */
export const SYNC_TIMEOUT_MS = 8_000;

const DOPPLER_API = "https://api.doppler.com";

/** A provider's refusal (`refused`: the credentials or the target are
 *  wrong, and trying again won't help) or its not answering. */
export class SyncError extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) {
    super(message);
    this.name = "SyncError";
    this.refused = refused;
  }
}

export type DopplerCredentials = { token: string };
export type InfisicalCredentials = { clientId: string; clientSecret: string };

/** `fetch`, with what went wrong on the way said as a {@link SyncError}. */
async function call(label: string, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal, redirect: "error" });
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SyncError(timedOut ? `${label} didn't answer in time.` : `Couldn't reach ${label}.`, false);
  }
}

/** A JSON body, or a SyncError that doesn't quote it. */
async function json(label: string, response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SyncError(`${label} answered with something that isn't JSON.`, false);
  }
}

/** The answer to give for a status that isn't a success, never its body. */
function unavailable(label: string, status: number): SyncError {
  return new SyncError(`${label} answered ${status}. Sessions start without its secrets until it answers again.`, false);
}

/** A record of string values, else a SyncError: a non-string value (a
 *  number a provider might send) is written out as text. */
function stringRecord(label: string, value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncError(`${label} answered with secrets in a shape Outrunner doesn't know.`, false);
  }
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === "string") out[name] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[name] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doppler

/** A Doppler config's secrets, as its secrets download gives them: with
 *  DOPPLER_PROJECT, DOPPLER_CONFIG and DOPPLER_ENVIRONMENT, as the Doppler CLI
 *  gives a process them. A service token reads its own config; any other
 *  names one. */
export async function dopplerSecrets(
  credentials: DopplerCredentials,
  target: { project: string | null; config: string | null },
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const url = new URL("/v3/configs/config/secrets/download", DOPPLER_API);
  url.searchParams.set("format", "json");
  if (target.project && target.config) {
    url.searchParams.set("project", target.project);
    url.searchParams.set("config", target.config);
  }
  const response = await call(
    "Doppler",
    url.toString(),
    { headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" } },
    signal,
  );
  const where = target.project && target.config ? `${target.project} / ${target.config}` : "its config";
  if (response.status === 401) throw new SyncError("Doppler refused the token: it may have been revoked. Reconnect Doppler with a new one.", true);
  if (response.status === 403) throw new SyncError(`Doppler's token can't read ${where}.`, true);
  if (response.status === 404) throw new SyncError(`Doppler has no config ${where}.`, true);
  if (response.status === 400 && !(target.project && target.config)) {
    throw new SyncError("Doppler needs a project and config for this token.", true);
  }
  if (!response.ok) throw unavailable("Doppler", response.status);
  return stringRecord("Doppler", await json("Doppler", response));
}

/** What a Doppler token reaches, checked before it's kept: its settings,
 *  and a label for the integrations page. A service token is asked for its
 *  config's secrets (it can do nothing else), whose DOPPLER_PROJECT and
 *  DOPPLER_CONFIG name it; any other token for who it is, then for the
 *  project and config it's given, which it must have. */
export async function checkDoppler(
  credentials: DopplerCredentials,
  tokenKind: DopplerSettings["tokenKind"],
  target: { project: string | null; config: string | null },
  signal: AbortSignal,
): Promise<{ settings: DopplerSettings; label: string }> {
  if (tokenKind === "service") {
    const secrets = await dopplerSecrets(credentials, { project: null, config: null }, signal);
    const project = secrets.DOPPLER_PROJECT ?? null;
    const config = secrets.DOPPLER_CONFIG ?? null;
    return {
      settings: { tokenKind, project, config },
      label: project && config ? `${project} / ${config}` : "Service token",
    };
  }
  if (!target.project || !target.config) {
    throw new SyncError("A personal or service account token needs the project and config to read.", true);
  }
  const response = await call(
    "Doppler",
    `${DOPPLER_API}/v3/me`,
    { headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" } },
    signal,
  );
  if (response.status === 401 || response.status === 403) {
    throw new SyncError("Doppler didn't accept that token.", true);
  }
  if (!response.ok) throw unavailable("Doppler", response.status);
  const me = (await json("Doppler", response)) as { workplace?: { name?: unknown } } | null;
  await dopplerSecrets(credentials, target, signal);
  const workplace = typeof me?.workplace?.name === "string" ? me.workplace.name.slice(0, 100) : null;
  return {
    settings: { tokenKind, project: target.project, config: target.config },
    label: `${workplace ? `${workplace}: ` : ""}${target.project} / ${target.config}`,
  };
}

// ---------------------------------------------------------------------------
// Infisical

/** An Infisical site as posted: its US cloud when none is given; otherwise
 *  https and a public host (the server calls it: never its own network), no
 *  trailing slash. Null for one refused. */
export function infisicalSiteUrl(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return INFISICAL_CLOUD;
  const url = webhookUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) return null;
  // The API is under /api of the site, which the user may have pasted too.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "").replace(/\/api$/, "")}`;
}

/** A machine identity's access token, by universal auth, and how many
 *  seconds it lasts. */
export async function infisicalLogin(
  siteUrl: string,
  credentials: InfisicalCredentials,
  signal: AbortSignal,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const response = await call(
    "Infisical",
    `${siteUrl}/api/v1/auth/universal-auth/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
    },
    signal,
  );
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    throw new SyncError(
      "Infisical didn't accept the machine identity's client ID and secret: they may have been revoked. Reconnect Infisical with new ones.",
      true,
    );
  }
  if (!response.ok) throw unavailable("Infisical", response.status);
  const body = (await json("Infisical", response)) as { accessToken?: unknown; expiresIn?: unknown } | null;
  if (typeof body?.accessToken !== "string" || body.accessToken === "") {
    throw new SyncError("Infisical answered its login without an access token.", false);
  }
  return { accessToken: body.accessToken, expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : null };
}

type InfisicalSecret = { secretKey?: unknown; secretValue?: unknown };
type InfisicalSecretsBody = { secrets?: InfisicalSecret[]; imports?: Array<{ secrets?: InfisicalSecret[] }> };

/** An Infisical folder's secrets, its imports' beneath its own (the first
 *  import listed winning a name among them), references expanded. Asked of
 *  the v4 API, and of v3's where a self-hosted site is too old for v4. */
export async function infisicalSecrets(
  siteUrl: string,
  accessToken: string,
  target: { projectId: string; environment: string; path: string },
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const ask = (version: "v4" | "v3") => {
    const url = new URL(version === "v4" ? `${siteUrl}/api/v4/secrets` : `${siteUrl}/api/v3/secrets/raw`);
    url.searchParams.set(version === "v4" ? "projectId" : "workspaceId", target.projectId);
    url.searchParams.set("environment", target.environment);
    url.searchParams.set("secretPath", target.path);
    url.searchParams.set("expandSecretReferences", "true");
    url.searchParams.set(version === "v4" ? "includeImports" : "include_imports", "true");
    url.searchParams.set("recursive", "false");
    return call(
      "Infisical",
      url.toString(),
      { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
      signal,
    );
  };
  let response = await ask("v4");
  if (response.status === 404 && (await routeMissing(response))) response = await ask("v3");

  const where = `${target.environment} ${target.path} of project ${target.projectId}`;
  if (response.status === 401) throw new SyncError("Infisical refused the machine identity's access token.", true);
  if (response.status === 403) throw new SyncError(`The machine identity can't read ${where}. Give it read access in Infisical.`, true);
  if (response.status === 404 || response.status === 400) throw new SyncError(`Infisical has no ${where}.`, true);
  if (!response.ok) throw unavailable("Infisical", response.status);

  const body = (await json("Infisical", response)) as InfisicalSecretsBody | null;
  if (!body || !Array.isArray(body.secrets)) {
    throw new SyncError("Infisical answered with secrets in a shape Outrunner doesn't know.", false);
  }
  const out: Record<string, string> = {};
  const add = (secrets: InfisicalSecret[] | undefined) => {
    for (const s of secrets ?? []) {
      if (typeof s.secretKey === "string" && typeof s.secretValue === "string") out[s.secretKey] = s.secretValue;
    }
  };
  for (const imported of [...(body.imports ?? [])].reverse()) add(imported.secrets);
  add(body.secrets);
  return out;
}

/** Whether a 404 is Infisical's server not knowing the route (an older
 *  self-hosted one) rather than the project or folder not being there.
 *  Fastify says "Route GET:/api/v4/secrets not found". */
async function routeMissing(response: Response): Promise<boolean> {
  const body = (await response.clone().json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" && body.message.startsWith("Route ");
}

/** What an Infisical machine identity reaches, checked before it's kept: it
 *  logs in, and reads the project and environment given, when one is. */
export async function checkInfisical(
  siteUrl: string,
  credentials: InfisicalCredentials,
  defaults: { projectId: string | null; environment: string | null },
  signal: AbortSignal,
): Promise<{ settings: InfisicalSettings; label: string }> {
  const { accessToken } = await infisicalLogin(siteUrl, credentials, signal);
  if (defaults.projectId && defaults.environment) {
    await infisicalSecrets(siteUrl, accessToken, { projectId: defaults.projectId, environment: defaults.environment, path: "/" }, signal);
  }
  const host = new URL(siteUrl).host;
  return {
    settings: { siteUrl, projectId: defaults.projectId, environment: defaults.environment },
    label: defaults.projectId && defaults.environment ? `${host}: ${defaults.projectId} · ${defaults.environment}` : host,
  };
}

// ---------------------------------------------------------------------------
// A link's secrets

/** What a session's box needs to run the `infisical` CLI as the link's
 *  machine identity, signed in, without `infisical login` or `init`: the CLI
 *  reads each of these (checked against v0.44). The access token lasts as
 *  long as the identity's access token TTL in Infisical; the client secret
 *  never leaves the server. */
export function infisicalCliEnv(
  siteUrl: string,
  accessToken: string,
  target: { projectId: string; environment: string; path: string },
): Record<string, string> {
  return {
    INFISICAL_TOKEN: accessToken,
    INFISICAL_API_URL: `${siteUrl}/api`,
    INFISICAL_PROJECT_ID: target.projectId,
    INFISICAL_ENVIRONMENT: target.environment,
    INFISICAL_SECRET_PATH: target.path,
    INFISICAL_DISABLE_UPDATE_CHECK: "true",
  };
}

/** A linked project's secrets from its provider, and for Infisical what its
 *  CLI needs. */
export async function linkSecrets(
  link:
    | { provider: "doppler"; credentials: DopplerCredentials; settings: DopplerSettings; link: DopplerLink }
    | { provider: "infisical"; credentials: InfisicalCredentials; settings: InfisicalSettings; link: InfisicalLink },
  signal: AbortSignal,
): Promise<{ env: Record<string, string>; cli: Record<string, string> | null }> {
  if (link.provider === "doppler") {
    const target = dopplerTarget(link.settings, link.link);
    if (link.settings.tokenKind === "account" && !(target.project && target.config)) {
      throw new SyncError("Pick the Doppler project and config this project reads.", true);
    }
    // A service token is asked without a target: it has only its own.
    const asked = link.settings.tokenKind === "service" ? { project: null, config: null } : target;
    return { env: await dopplerSecrets(link.credentials, asked, signal), cli: null };
  }
  const target = infisicalTarget(link.settings, link.link);
  if (!target.projectId || !target.environment) {
    throw new SyncError("Pick the Infisical project and environment this project reads.", true);
  }
  const resolved = { projectId: target.projectId, environment: target.environment, path: target.path };
  const { accessToken } = await infisicalLogin(link.settings.siteUrl, link.credentials, signal);
  const env = await infisicalSecrets(link.settings.siteUrl, accessToken, resolved, signal);
  return { env, cli: infisicalCliEnv(link.settings.siteUrl, accessToken, resolved) };
}
