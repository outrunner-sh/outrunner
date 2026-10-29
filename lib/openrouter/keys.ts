/**
 * The OpenRouter key Outrunner's own models run on.
 *
 * Two setups, chosen by what the server is given:
 *   - OPENROUTER_MANAGEMENT_KEY: each user gets a key of their own, created
 *     through OpenRouter's management API and capped by OpenRouter itself. A
 *     leaked key spends that user's allowance and nothing more, and can be
 *     disabled without touching anyone else's. Preferred whenever it is set.
 *   - OPENROUTER_API_KEY alone: every session runs on that one key. Claude can
 *     read its own environment, so any user's session can copy the key and
 *     spend up to whatever limit it has on OpenRouter; there is no per-user
 *     cap. Chosen deliberately, for now, as the simpler setup.
 *
 * No imports from Next or the database, so it unit-tests with a stubbed fetch.
 */

const KEYS_URL = "https://openrouter.ai/api/v1/keys";

/** How long any one call to OpenRouter may take. Without it a hung OpenRouter
 *  leaves the model menu on "Switching…", and a key created by a call that
 *  never returns is the more likely to be left unstored. */
const TIMEOUT_MS = 10_000;

/** fetch, given up on after {@link TIMEOUT_MS}: every call here goes through it. */
function openRouter(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Neither key is configured (or OpenRouter refused the management key), so
 *  Outrunner's models are unavailable. */
export class OutrunnerModelsUnavailableError extends Error {
  constructor() {
    super("Outrunner's models are not set up on this server.");
    this.name = "OutrunnerModelsUnavailableError";
  }
}

/** OpenRouter refused a change to a key, with its HTTP status. */
export class OpenRouterKeyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterKeyError";
    this.status = status;
  }
}

/** The user's key can't run anything, so it isn't handed out: handed out, it
 *  would only fail inside the session with OpenRouter's raw error. The message
 *  is for the user. */
export class ModelKeyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelKeyRefusedError";
  }
}

/** The period's allowance is spent. A new period (or plan) raises the cap. */
export class AllowanceSpentError extends ModelKeyRefusedError {
  constructor() {
    super(
      "You've used your included usage of Outrunner's models. Connect Claude, or add your own OpenRouter key in Personal → Coding agents, to keep going.",
    );
    this.name = "AllowanceSpentError";
  }
}

/** The key was disabled on OpenRouter, by hand: it stays off until someone
 *  turns it back on. */
export class ModelKeyDisabledError extends ModelKeyRefusedError {
  constructor() {
    super(
      "Outrunner's models are turned off for this account. Connect Claude, or add your own OpenRouter key in Personal → Coding agents.",
    );
    this.name = "ModelKeyDisabledError";
  }
}

/** The server's OpenRouter management key, or null without one. */
export function managementKey(): string | null {
  return process.env.OPENROUTER_MANAGEMENT_KEY?.trim() || null;
}

/** The one key every session shares when there is no management key. */
export function sharedApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY?.trim() || null;
}

/** How a user's key is found: their own (created on first use), the shared
 *  one, or none at all. A management key wins: it is the capped setup. */
export function keySource(): "per-user" | "shared" | null {
  if (managementKey()) return "per-user";
  if (sharedApiKey()) return "shared";
  return null;
}

/** OpenRouter's account of the key a request is made with. */
const CURRENT_KEY_URL = "https://openrouter.ai/api/v1/key";

/** OpenRouter's account of a key, read on that key's own authority: what it
 *  has spent in USD, in all and this UTC day, week and month; its cap, null
 *  when it has none; and whether it is a management key, which can make keys
 *  but not run a model. A figure OpenRouter leaves out is null. */
export type CurrentKey = {
  management: boolean;
  usedUsd: number | null;
  dailyUsd: number | null;
  weeklyUsd: number | null;
  monthlyUsd: number | null;
  limitUsd: number | null;
  remainingUsd: number | null;
};

/** OpenRouter answered, but not with the key: `status` says why (a 429 is a
 *  key it knows, but is limiting). The body is never read into it: it could
 *  echo the key back. */
export class OpenRouterAnswerError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`OpenRouter answered ${status} reading a key`);
    this.name = "OpenRouterAnswerError";
    this.status = status;
  }
}

/**
 * Read `key`'s own account from OpenRouter (Settings → Providers checks a
 * user's key with it; Settings → Usage shows what it spent): null when
 * OpenRouter refuses the key, an {@link OpenRouterAnswerError} for any other
 * answer but its account, a throw when OpenRouter can't be reached.
 */
export async function readCurrentKey(key: string): Promise<CurrentKey | null> {
  const response = await openRouter(CURRENT_KEY_URL, { headers: { authorization: `Bearer ${key}` } });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new OpenRouterAnswerError(response.status);
  const data = ((await response.json().catch(() => null)) as { data?: Record<string, unknown> } | null)?.data ?? {};
  return {
    // is_provisioning_key is OpenRouter's older name for it.
    management: data.is_management_key === true || data.is_provisioning_key === true,
    usedUsd: usd(data.usage),
    dailyUsd: usd(data.usage_daily),
    weeklyUsd: usd(data.usage_weekly),
    monthlyUsd: usd(data.usage_monthly),
    limitUsd: usd(data.limit),
    remainingUsd: usd(data.limit_remaining),
  };
}

function usd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether OpenRouter takes `key` for running models (Settings → Providers checks
 * a user's own before keeping it): false when it refuses it, or when it is a
 * management key; a throw when OpenRouter can't be asked.
 */
export async function openRouterAcceptsKey(key: string): Promise<boolean> {
  const current = await readCurrentKey(key);
  return current !== null && !current.management;
}

export type CreatedKey = {
  /** The key itself. OpenRouter returns it only in this response. */
  key: string;
  /** OpenRouter's id for the key, for reading its usage or disabling it. */
  hash: string;
};

/**
 * Create a key for one user, capped at `limitUsd` (their plan's allowance,
 * lib/billing/plans.ts). `name` labels it in the OpenRouter dashboard; it
 * should identify the user without personal data. limit_reset null is
 * OpenRouter's "no reset": a monthly allowance raises the cap each period
 * instead, so periods follow the user's billing, not the calendar.
 *
 * Errors carry OpenRouter's status but never its body, which could echo the
 * request back.
 */
export async function createUserKey(name: string, limitUsd: number): Promise<CreatedKey> {
  const management = managementKey();
  if (!management) throw new OutrunnerModelsUnavailableError();

  const response = await openRouter(KEYS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${management}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name,
      limit: limitUsd,
      limit_reset: null,
    }),
  });
  // OpenRouter refusing the management key itself (a revoked one, or an
  // ordinary API key in its place) is this server's setup, not a hiccup a retry
  // would fix.
  if (response.status === 401 || response.status === 403) {
    console.error(`OpenRouter refused OPENROUTER_MANAGEMENT_KEY (HTTP ${response.status}); is it a management key?`);
    throw new OutrunnerModelsUnavailableError();
  }
  if (!response.ok) {
    throw new Error(`OpenRouter would not create a key (HTTP ${response.status}).`);
  }
  const body = (await response.json().catch(() => null)) as {
    key?: unknown;
    data?: { hash?: unknown };
  } | null;
  const key = body?.key;
  const hash = body?.data?.hash;
  if (typeof key !== "string" || !key || typeof hash !== "string" || !hash) {
    throw new Error("OpenRouter's response had no key in it.");
  }
  return { key, hash };
}

/**
 * Disable a user's key, so it can spend nothing more. Used for a key that lost
 * a race to be stored, or one whose stored copy can no longer be decrypted —
 * either is still live on OpenRouter with its own allowance until this runs —
 * and for the Slack agent's old keys of its own, retired by the reconciler
 * (lib/db/slack-agent.ts). An OpenRouterKeyError carries OpenRouter's status.
 */
export async function disableUserKey(hash: string): Promise<void> {
  const management = managementKey();
  if (!management) throw new OutrunnerModelsUnavailableError();

  const response = await openRouter(`${KEYS_URL}/${encodeURIComponent(hash)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${management}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ disabled: true }),
  });
  if (!response.ok) {
    throw new OpenRouterKeyError(`OpenRouter would not disable a key (HTTP ${response.status}).`, response.status);
  }
}

/** Cap a user's key at `limitUsd` of spend over its life: how a period's
 *  allowance is given (lib/billing/model-allowance.ts). */
export async function setKeyLimit(hash: string, limitUsd: number): Promise<void> {
  const management = managementKey();
  if (!management) throw new OutrunnerModelsUnavailableError();

  const response = await openRouter(`${KEYS_URL}/${encodeURIComponent(hash)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${management}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: limitUsd }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter would not change a key's limit (HTTP ${response.status}).`);
  }
}

/** What a user's key has spent and may spend, in USD, as OpenRouter counts it,
 *  and whether it was disabled there. */
export type KeyUsage = { usedUsd: number; limitUsd: number | null; disabled: boolean };

/** Read a user's key's spend (for the sidebar's allowance bar, and to refuse a
 *  key that can't run anything). */
export async function keyUsage(hash: string): Promise<KeyUsage> {
  const management = managementKey();
  if (!management) throw new OutrunnerModelsUnavailableError();

  const response = await openRouter(`${KEYS_URL}/${encodeURIComponent(hash)}`, {
    headers: { authorization: `Bearer ${management}` },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter would not read a key's usage (HTTP ${response.status}).`);
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { usage?: unknown; limit?: unknown; disabled?: unknown };
  } | null;
  const used = body?.data?.usage;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    throw new Error("OpenRouter's response had no usage in it.");
  }
  const limit = body?.data?.limit;
  return {
    usedUsd: used,
    limitUsd: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
    disabled: body?.data?.disabled === true,
  };
}
