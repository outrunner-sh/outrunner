/**
 * Asking a provider whether it takes a key, before Settings → Providers keeps
 * it. No imports from Next or the database, so it tests with a stubbed fetch.
 */

import { openRouterAcceptsKey } from "@/lib/openrouter/keys";
import { PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** Accepted, perhaps with something the user should know (no credit left);
 *  or refused. A provider that can't be asked throws instead. */
export type KeyCheckResult = { accepted: true; warning?: string } | { accepted: false };

/** As long as any one call to a provider may take: a hung one mustn't leave
 *  the Save button on "Checking" for good. */
const TIMEOUT_MS = 10_000;

export async function checkProviderKey(provider: ProviderId, key: string): Promise<KeyCheckResult> {
  // OpenRouter also takes a management key, which can make keys but not run
  // a model: its own check refuses one.
  if (provider === "openrouter") return { accepted: await openRouterAcceptsKey(key) };

  const { label, check } = PROVIDERS[provider];
  const response = await fetch(check.url, {
    headers: {
      ...check.headers,
      ...(check.auth === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return { accepted: false };
  // The key is good; the account can't pay for anything yet.
  if (response.status === 402) {
    return { accepted: true, warning: `${label} accepted the key, but its account has no credit left.` };
  }
  // The body is never read into the error: it could echo the key back.
  if (!response.ok) throw new Error(`${label} answered ${response.status} checking a key`);
  return { accepted: true };
}
