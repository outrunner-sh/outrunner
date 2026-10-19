import { PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** A model on the user's own key for `provider` was asked for, and they have
 *  none saved. The message says where to add one. */
export class NoProviderKeyError extends Error {
  readonly provider: ProviderId;
  readonly settingsHref = "/settings/providers";
  constructor(provider: ProviderId) {
    super(`Save your ${PROVIDERS[provider].label} key in Settings → Providers to run models on it.`);
    this.name = "NoProviderKeyError";
    this.provider = provider;
  }
}
