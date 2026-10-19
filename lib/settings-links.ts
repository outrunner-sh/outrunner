/**
 * Where Settings → Providers (BYOK) is, and its tabs: the user's Claude
 * subscription, then a provider each (lib/providers/registry.ts). `?tab=`
 * opens one, so a "connect Claude" link lands on Claude.
 */

import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";

export type ProviderTab = "claude" | ProviderId;

export const PROVIDER_TABS: ProviderTab[] = ["claude", ...PROVIDER_IDS];

export function isProviderTab(value: unknown): value is ProviderTab {
  return PROVIDER_TABS.includes(value as ProviderTab);
}

export const PROVIDERS_SETTINGS_HREF = "/settings/providers";

/** Settings → Providers, open on `tab`. */
export function providerSettingsHref(tab: ProviderTab): string {
  return `${PROVIDERS_SETTINGS_HREF}?tab=${tab}`;
}
