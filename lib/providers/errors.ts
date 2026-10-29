import { PROVIDERS, type ProviderId } from "@/lib/providers/registry";
import { providerSettingsHref } from "@/lib/settings-links";

/** A model on the user's own key for `provider` was asked for, and they have
 *  none saved. The message says where to add one. */
export class NoProviderKeyError extends Error {
  readonly provider: ProviderId;
  /** Settings → Providers, open on this provider's tab. */
  readonly settingsHref: string;
  constructor(provider: ProviderId) {
    super(`Save your ${PROVIDERS[provider].label} key in Personal → Coding agents to run models on it.`);
    this.name = "NoProviderKeyError";
    this.provider = provider;
    this.settingsHref = providerSettingsHref(provider);
  }
}
