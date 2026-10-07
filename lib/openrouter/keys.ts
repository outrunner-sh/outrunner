/**
 * Per-user OpenRouter keys for Neev AI, through OpenRouter's management API.
 *
 * Neev pays for Neev AI, so the key a user's box runs on must not be Neev's
 * own: Claude runs there with bypassPermissions and could read any key out of
 * its environment. Each user gets a key of their own instead, capped by
 * OpenRouter itself — a leaked key can spend that user's allowance and nothing
 * more, and it can be disabled without touching anyone else's.
 *
 * No imports from Next or the database, so it unit-tests with a stubbed fetch.
 */

const KEYS_URL = "https://openrouter.ai/api/v1/keys";

/** What each user may spend on Neev AI before there is billing, in USD. */
export const NEEV_AI_LIMIT_USD = 5;
/** The allowance renews at midnight UTC on the 1st of each month. */
export const NEEV_AI_LIMIT_RESET = "monthly";

/** The management key is not configured, so Neev AI is unavailable. */
export class NeevAiUnavailableError extends Error {
  constructor() {
    super("Neev AI is not set up on this server.");
    this.name = "NeevAiUnavailableError";
  }
}

/** The server's OpenRouter management key, or null when Neev AI is off. */
export function managementKey(): string | null {
  return process.env.OPENROUTER_MANAGEMENT_KEY?.trim() || null;
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
      limit_reset: NEEV_AI_LIMIT_RESET,
    }),
  });
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
