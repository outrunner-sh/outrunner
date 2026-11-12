import { lookup } from "node:dns/promises";

import { isPrivateAddress, webhookUrl } from "@/lib/api/webhooks";

/**
 * What a user may point Outrunner's servers at for their own E2B (Settings →
 * Sandbox). Their URLs are called from our servers with their key, and our
 * relay and preview proxy connect to them, so like a webhook they must be
 * https on a public host: never this network, a cloud's metadata service, or
 * another internal address.
 */

/** A self-hosted E2B URL as posted: https on a public host, with no path
 *  past "/" kept. Null for none given; undefined for one refused. */
export function e2bUrl(value: unknown): string | null | undefined {
  const url = webhookUrl(typeof value === "string" ? value.trim() : value);
  if (!url) return url;
  const parsed = new URL(url);
  return parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : undefined;
}

/** Throws unless every address `url`'s host has now is public: checked as a
 *  connection is made, since a name can point anywhere after it was saved. */
export async function assertPublicHost(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${host} points at a private address, which Outrunner won't connect to.`);
  }
}

/** Whether E2B at `apiUrl` (its cloud when unset) accepts `apiKey`: false
 *  when it refuses it, a throw when it can't be asked. */
export async function e2bAcceptsKey(apiKey: string, apiUrl?: string): Promise<boolean> {
  const [{ AuthenticationError, Sandbox }, { e2bSdkOptions }] = await Promise.all([
    import("e2b"),
    import("@/lib/runtime/sandbox/e2b-sdk"),
  ]);
  const options = { ...e2bSdkOptions({ apiKey, apiUrl }, 20_000), limit: 1 };
  try {
    await Sandbox.list(options).nextItems();
    return true;
  } catch (error) {
    if (error instanceof AuthenticationError) return false;
    throw error;
  }
}
