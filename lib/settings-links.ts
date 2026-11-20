/**
 * Where Settings → Providers (BYOK) is, and its tabs: a tab per agent
 * (lib/agents/registry.ts), then a tab per model provider Claude Code runs
 * through (lib/providers/registry.ts). A provider whose key is an agent's
 * (Anthropic's, OpenAI's) has no tab of its own: its key is that agent's API
 * key. `?tab=` opens a tab, and `&method=` one of an agent's ways of signing
 * in, so a "connect Claude" link lands on Claude Code.
 */

import {
  AGENT_IDS,
  type AgentId,
  agentOfKey,
  type AuthMethodId,
  authMethod,
  isAgentId,
} from "@/lib/agents/registry";
import {
  isKeyProviderId,
  type KeyProviderId,
  PROVIDER_IDS,
  type ProviderId,
} from "@/lib/providers/registry";

/** A model provider's tab: a gateway whose key is no agent's. */
export type GatewayTab = Exclude<ProviderId, "anthropic">;

export type ProviderTab = AgentId | GatewayTab;

export const GATEWAY_TABS = PROVIDER_IDS.filter(
  (id): id is GatewayTab => agentOfKey(id) === null,
);

export const PROVIDER_TABS: ProviderTab[] = [...AGENT_IDS, ...GATEWAY_TABS];

export function isProviderTab(value: unknown): value is ProviderTab {
  return PROVIDER_TABS.includes(value as ProviderTab);
}

export const PROVIDERS_SETTINGS_HREF = "/settings/coding-agents";

/** Personal provider-account usage; shared allowance is /settings/org/usage. */
export const USAGE_SETTINGS_HREF = "/settings/usage";

/** Where a link to Settings → Providers lands: a tab, and on an agent's tab,
 *  the way of signing in to show. */
export type ProviderPlace = { tab: ProviderTab; method?: AuthMethodId };

/** The place a link names: a tab, or a provider whose key is an agent's,
 *  which is that agent's API key. Null for anything else. */
function placeOf(where: unknown): ProviderPlace | null {
  if (isProviderTab(where)) return { tab: where };
  if (isKeyProviderId(where)) {
    const agent = agentOfKey(where);
    if (agent) return { tab: agent, method: "api-key" };
  }
  return null;
}

/**
 * The place `?tab=` and `?method=` ask for, or null for junk. A tab from
 * before agents had tabs still lands: `?tab=anthropic` on Claude Code's API
 * key. A method only counts on an agent's tab, and only one it has.
 */
export function parseProviderPlace(
  tab: unknown,
  method?: unknown,
): ProviderPlace | null {
  const place = placeOf(tab);
  if (!place) return null;
  if (isAgentId(place.tab) && authMethod(place.tab, method)) {
    return { tab: place.tab, method: method as AuthMethodId };
  }
  return place;
}

/** Settings → Providers, open on a tab, or on where a provider's key goes;
 *  on an agent's tab, showing `method`. */
export function providerSettingsHref(
  where: ProviderTab | KeyProviderId,
  method?: AuthMethodId,
): string {
  const place = placeOf(where) ?? { tab: "claude" as const };
  const shown = isAgentId(place.tab) ? (method ?? place.method) : undefined;
  return `${PROVIDERS_SETTINGS_HREF}?tab=${place.tab}${shown ? `&method=${shown}` : ""}`;
}

/** `url` (Settings → Providers) open on `tab`, for the address bar as the
 *  user moves between tabs: the method a link named was for the tab it opened. */
export function withProviderTab(url: URL, tab: ProviderTab): string {
  const next = new URL(url);
  next.searchParams.set("tab", tab);
  next.searchParams.delete("method");
  return `${next.pathname}${next.search}${next.hash}`;
}

/** Select an authentication card while retaining callback and deep-link context. */
export function withProviderMethod(
  url: URL,
  tab: AgentId,
  method: AuthMethodId,
): string {
  const next = new URL(url);
  next.searchParams.set("tab", tab);
  next.searchParams.set("method", method);
  return `${next.pathname}${next.search}${next.hash}`;
}

export type SettingsQuery = Record<string, string | string[] | undefined>;
/** Legacy Codex account links opened the active org's scope on #328.
 * Personal API-key/local-method links and every other provider remain
 * personal. */
export function legacyProviderSettingsHref(
  params: SettingsQuery,
  org?: { id: string } | null,
): string {
  const shared =
    params.tab === "codex" &&
    (params.method === undefined || params.method === "codex-account") &&
    Boolean(org);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value])
      search.append(key, entry);
  }
  return `${shared ? "/settings/org/coding-agents" : PROVIDERS_SETTINGS_HREF}${search.size ? `?${search}` : ""}`;
}
