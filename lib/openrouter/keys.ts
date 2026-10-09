/**
 * The OpenRouter key Outrunner's own models (Neev AI, in code) run on.
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

/** What each user may spend on Neev AI before there is billing, in USD: once,
 *  in total. The key is created with limit_reset null, OpenRouter's "no reset". */
export const NEEV_AI_LIMIT_USD = 5;

/** Neither key is configured (or OpenRouter refused the management key), so
 *  Outrunner's models are unavailable. */
export class NeevAiUnavailableError extends Error {
  constructor() {
    super("Outrunner's models are not set up on this server.");
    this.name = "NeevAiUnavailableError";
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

export type CreatedKey = {
  /** The key itself. OpenRouter returns it only in this response. */
  key: string;
  /** OpenRouter's id for the key, for reading its usage or disabling it. */
  hash: string;
};

/**
 * Create a capped key for one user. `name` labels it in the OpenRouter
 * dashboard; it should identify the user without personal data.
 *
 * Errors carry OpenRouter's status but never its body, which could echo the
 * request back.
 */
export async function createUserKey(name: string): Promise<CreatedKey> {
  const management = managementKey();
  if (!management) throw new NeevAiUnavailableError();

  const response = await fetch(KEYS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${management}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name,
      limit: NEEV_AI_LIMIT_USD,
      limit_reset: null,
    }),
  });
  // OpenRouter refusing the management key itself (a revoked one, or an
  // ordinary API key in its place) is this server's setup, not a hiccup a retry
  // would fix.
  if (response.status === 401 || response.status === 403) {
    console.error(`OpenRouter refused OPENROUTER_MANAGEMENT_KEY (HTTP ${response.status}); is it a management key?`);
    throw new NeevAiUnavailableError();
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
 * either is still live on OpenRouter with its own allowance until this runs.
 */
export async function disableUserKey(hash: string): Promise<void> {
  const management = managementKey();
  if (!management) throw new NeevAiUnavailableError();

  const response = await fetch(`${KEYS_URL}/${encodeURIComponent(hash)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${management}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ disabled: true }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter would not disable a key (HTTP ${response.status}).`);
  }
}
