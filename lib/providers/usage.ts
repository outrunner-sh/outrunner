/**
 * What the user's own keys have spent, for Settings → Usage, asked of each
 * provider on the key's own authority. Sessions call providers directly, so
 * this is the only account there is: where a provider gives none for an
 * ordinary key (Anthropic and OpenAI keep usage behind an admin key; Z.ai has
 * no API for it) the page links to its dashboard instead. No imports from Next
 * or the database, so it tests with a stubbed fetch.
 */

import { OpenRouterAnswerError, readCurrentKey } from "@/lib/openrouter/keys";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/check";
import { type KeyProviderId, PROVIDER_IDS, PROVIDERS } from "@/lib/providers/registry";

/**
 * A key's usage, as its provider counts it:
 *   - `spend`: what it has spent in USD, in all and this UTC day, week and
 *     month, and its cap (null: none). A figure the provider leaves out is null.
 *   - `balance`: the account's credit left, in each currency it holds, and
 *     whether that's enough to call the API. Prepaid providers count this, not
 *     spend.
 */
export type ProviderUsage =
  | {
      kind: "spend";
      usedUsd: number | null;
      dailyUsd: number | null;
      weeklyUsd: number | null;
      monthlyUsd: number | null;
      limitUsd: number | null;
      remainingUsd: number | null;
    }
  | { kind: "balance"; available: boolean; balances: { currency: string; amount: number }[] };

/** Why a key's usage couldn't be read: the provider refused the key, is
 *  limiting it, or couldn't be asked (down, a timeout, an answer we can't read). */
export type UsageProblem = "refused" | "rate-limited" | "unavailable";

export type UsageRead = { ok: true; usage: ProviderUsage } | { ok: false; problem: UsageProblem };

/** A provider refused the key, or is limiting it; anything else a reader
 *  throws is "unavailable". */
class UsageReadError extends Error {
  readonly problem: UsageProblem;
  constructor(problem: UsageProblem) {
    super(problem);
    this.name = "UsageReadError";
    this.problem = problem;
  }
}

type UsageReader = (key: string) => Promise<ProviderUsage>;

/** What an HTTP status says of the key; null when it says nothing (a 5xx). */
function problemFor(status: number): UsageProblem | null {
  if (status === 401 || status === 403) return "refused";
  if (status === 429) return "rate-limited";
  return null;
}

async function readOpenRouter(key: string): Promise<ProviderUsage> {
  let current;
  try {
    current = await readCurrentKey(key);
  } catch (error) {
    const problem = error instanceof OpenRouterAnswerError ? problemFor(error.status) : null;
    throw problem ? new UsageReadError(problem) : error;
  }
  if (!current) throw new UsageReadError("refused");
  return {
    kind: "spend",
    usedUsd: current.usedUsd,
    dailyUsd: current.dailyUsd,
    weeklyUsd: current.weeklyUsd,
    monthlyUsd: current.monthlyUsd,
    limitUsd: current.limitUsd,
    remainingUsd: current.remainingUsd,
  };
}

/** GET `url` on `key`, as JSON. The body is never read into an error: it
 *  could echo the key back. */
async function askWithKey(url: string, key: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    const problem = problemFor(response.status);
    throw problem ? new UsageReadError(problem) : new Error(`answered ${response.status} reading usage`);
  }
  return response.json();
}

/** A provider's amount, a number or a decimal string (DeepSeek's), or null. */
function amount(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** DeepSeek: the account's balance, in each currency it holds (CNY or USD),
 *  as decimal strings. */
async function readDeepSeek(key: string): Promise<ProviderUsage> {
  const body = (await askWithKey("https://api.deepseek.com/user/balance", key)) as {
    is_available?: unknown;
    balance_infos?: unknown;
  } | null;
  if (!Array.isArray(body?.balance_infos)) throw new Error("DeepSeek's answer had no balance in it");
  const balances = body.balance_infos.flatMap((info: { currency?: unknown; total_balance?: unknown }) => {
    const total = amount(info?.total_balance);
    return typeof info?.currency === "string" && total !== null ? [{ currency: info.currency, amount: total }] : [];
  });
  return { kind: "balance", available: body.is_available === true, balances };
}

/** Moonshot (api.moonshot.ai): the account's balance in USD, cash and
 *  vouchers together; at 0 or below, calls fail. */
async function readMoonshot(key: string): Promise<ProviderUsage> {
  const body = (await askWithKey("https://api.moonshot.ai/v1/users/me/balance", key)) as {
    data?: { available_balance?: unknown };
  } | null;
  const available = amount(body?.data?.available_balance);
  if (available === null) throw new Error("Moonshot's answer had no balance in it");
  return { kind: "balance", available: available > 0, balances: [{ currency: "USD", amount: available }] };
}

/** Each provider's reader, or null where it gives no usage for an ordinary
 *  key. One missing here fails the build. */
export const USAGE_READERS: Record<KeyProviderId, UsageReader | null> = {
  openrouter: readOpenRouter,
  // Usage and cost need an Admin API key, which can't run a model.
  anthropic: null,
  // No usage or balance API: its console only.
  zai: null,
  moonshot: readMoonshot,
  deepseek: readDeepSeek,
  // Usage needs an admin key, which can't run a model.
  openai: null,
};

/** Read `key`'s usage from `provider`, never throwing: what went wrong comes
 *  back as a {@link UsageProblem}, and anything unexpected is logged. */
export async function readProviderUsage(provider: KeyProviderId, key: string): Promise<UsageRead> {
  const reader = USAGE_READERS[provider];
  if (!reader) return { ok: false, problem: "unavailable" };
  try {
    return { ok: true, usage: await reader(key) };
  } catch (error) {
    if (error instanceof UsageReadError) return { ok: false, problem: error.problem };
    console.error(`Could not read ${PROVIDERS[provider].label} usage`, error);
    return { ok: false, problem: "unavailable" };
  }
}

/**
 * One card on Settings → Usage:
 *   - `outrunner`: the allowance on Outrunner's models; `metered` false where
 *     the server runs them on one shared key, which counts nobody's use;
 *   - `claude`: the user's Claude subscription, whose use Claude shows only on
 *     its own site;
 *   - `key`: one of the user's own keys (its last 4), and whether its provider
 *     gives usage to read (`reads`), or only a dashboard to link to.
 */
export type UsageCard =
  | { kind: "outrunner"; metered: boolean }
  | { kind: "claude" }
  | { kind: "key"; provider: KeyProviderId; hint: string | null; reads: boolean };

/**
 * The cards, in the model menu's order (session-models.ts modelGroups):
 * Outrunner's models where the server has them, each provider key, the Claude
 * subscription, then OpenAI's key (Codex's).
 */
export function usageCards({
  outrunner,
  claude,
  keys,
}: {
  /** lib/openrouter/keys.ts keySource(). */
  outrunner: "per-user" | "shared" | null;
  /** Whether a Claude subscription is connected. */
  claude: boolean;
  /** Which providers the user has a key for, and its last 4
   *  (credentials.ts getProviderKeyStatuses). */
  keys: Record<KeyProviderId, { connected: boolean; hint: string | null }>;
}): UsageCard[] {
  const keyCard = (provider: KeyProviderId): UsageCard[] =>
    keys[provider].connected
      ? [{ kind: "key", provider, hint: keys[provider].hint, reads: USAGE_READERS[provider] !== null }]
      : [];
  return [
    ...(outrunner ? [{ kind: "outrunner" as const, metered: outrunner === "per-user" }] : []),
    ...PROVIDER_IDS.flatMap(keyCard),
    ...(claude ? [{ kind: "claude" as const }] : []),
    ...keyCard("openai"),
  ];
}
