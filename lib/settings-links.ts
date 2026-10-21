/**
 * Where Settings → Providers (BYOK) is, and its tabs: a tab per agent
 * (lib/agents/registry.ts), then a tab per model provider Claude Code runs
 * through (lib/providers/registry.ts). A provider whose key is an agent's
 * (Anthropic's, OpenAI's) has no tab of its own: its key is that agent's API
 * key. `?tab=` opens a tab, and `&method=` one of an agent's ways of signing
 * in, so a "connect Claude" link lands on Claude Code.
 */

import { AGENT_IDS, type AgentId, agentOfKey, type AuthMethodId, authMethod, isAgentId } from "@/lib/agents/registry";
import { isKeyProviderId, type KeyProviderId, PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";

/** A model provider's tab: a gateway whose key is no agent's. */
export type GatewayTab = Exclude<ProviderId, "anthropic">;

export type ProviderTab = AgentId | GatewayTab;

export const GATEWAY_TABS = PROVIDER_IDS.filter((id): id is GatewayTab => agentOfKey(id) === null);

export const PROVIDER_TABS: ProviderTab[] = [...AGENT_IDS, ...GATEWAY_TABS];

export function isProviderTab(value: unknown): value is ProviderTab {
  return PROVIDER_TABS.includes(value as ProviderTab);
}

export const PROVIDERS_SETTINGS_HREF = "/settings/providers";

/** Settings → Usage: Outrunner's models, and what the user's own keys spent. */
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
export function parseProviderPlace(tab: unknown, method?: unknown): ProviderPlace | null {
  const place = placeOf(tab);
  if (!place) return null;
  if (isAgentId(place.tab) && authMethod(place.tab, method)) {
    return { tab: place.tab, method: method as AuthMethodId };
  }
  return place;
}

/** Settings → Providers, open on a tab, or on where a provider's key goes;
 *  on an agent's tab, showing `method`. */
export function providerSettingsHref(where: ProviderTab | KeyProviderId, method?: AuthMethodId): string {
  const place = placeOf(where) ?? { tab: "claude" as const };
  const shown = isAgentId(place.tab) ? (method ?? place.method) : undefined;
  return `${PROVIDERS_SETTINGS_HREF}?tab=${place.tab}${shown ? `&method=${shown}` : ""}`;
}
