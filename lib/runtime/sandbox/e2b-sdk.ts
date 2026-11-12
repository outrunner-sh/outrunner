/**
 * The E2B SDK's options for one E2B, named outright. Unnamed, the SDK falls
 * back to E2B_API_URL, E2B_SANDBOX_URL and E2B_DOMAIN in this process's
 * environment, which would send a user's key, or their boxes' traffic, to
 * whatever E2B those name: so E2B's cloud is spelled out, and a fallback the
 * SDK would still take is refused.
 */

export const E2B_CLOUD_DOMAIN = "e2b.app";

/** The SDK's own fallbacks, none of which Outrunner sets. */
const SDK_FALLBACKS = ["E2B_API_URL", "E2B_SANDBOX_URL", "E2B_DOMAIN"] as const;

/** Options reaching the E2B at `apiUrl` (E2B's cloud when unset) on `apiKey`,
 *  its boxes through `sandboxUrl` (a self-hosted client-proxy) when set. */
export function e2bSdkOptions(
  target: { apiKey: string; apiUrl?: string; sandboxUrl?: string; proxy?: string },
  requestTimeoutMs = 2 * 60 * 1000,
) {
  const set = SDK_FALLBACKS.filter((name) => process.env[name]);
  if (set.length > 0) {
    throw new Error(
      `Unset ${set.join(", ")}: the E2B SDK would use ${set.length > 1 ? "them" : "it"} for E2Bs that name none, ` +
        "users' among them. The deployment's own E2B is OUTRUNNER_E2B_*.",
    );
  }
  return {
    apiKey: target.apiKey,
    apiUrl: target.apiUrl ?? `https://api.${E2B_CLOUD_DOMAIN}`,
    sandboxUrl: target.sandboxUrl,
    domain: E2B_CLOUD_DOMAIN,
    requestTimeoutMs,
    ...(target.proxy ? { proxy: target.proxy } : {}),
  };
}

/**
 * Options for a user's E2B: as {@link e2bSdkOptions}, and for a self-hosted
 * one (a URL the user named), through the egress proxy (e2b-egress.ts), which
 * reaches only the hosts they named, public-only. The SDK follows redirects
 * with the key on and resolves names as it connects; through the proxy a
 * redirect to any other host, or a name that turns private, goes nowhere.
 * E2B's cloud is E2B's, and is reached direct.
 */
export async function userE2bSdkOptions(
  target: { apiKey: string; apiUrl?: string; sandboxUrl?: string },
  requestTimeoutMs = 2 * 60 * 1000,
) {
  return e2bSdkOptions({ ...target, proxy: await userE2bProxy(target) }, requestTimeoutMs);
}

/** A fetch whose every connection, redirects included, goes through the
 *  egress proxy at `proxyUrl` (e2b-egress.ts): for our own calls to a user's
 *  self-hosted E2B (control calls to its client-proxy, its template API).
 *  One per proxy URL, kept. */
export async function proxiedFetch(proxyUrl: string): Promise<typeof fetch> {
  let made = PROXIED.get(proxyUrl);
  if (made) {
    // Most recently used last, so the oldest is the one let go.
    PROXIED.delete(proxyUrl);
  } else {
    made = import("undici").then(({ fetch: undiciFetch, ProxyAgent }) => {
      const dispatcher = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
      const fetchVia = ((input: RequestInfo | URL, init?: RequestInit) =>
        undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
      return { fetch: fetchVia, close: () => dispatcher.close() };
    });
  }
  PROXIED.set(proxyUrl, made);
  // Bounded: each user's hosts make their own, and one saved over is never asked for again.
  while (PROXIED.size > MAX_PROXIED) {
    const [oldest, entry] = PROXIED.entries().next().value!;
    PROXIED.delete(oldest);
    void entry.then((e) => e.close()).catch(() => {});
  }
  return (await made).fetch;
}
const MAX_PROXIED = 32;
const PROXIED = new Map<string, Promise<{ fetch: typeof fetch; close: () => Promise<void> }>>();

/** Close every proxied fetch's connections: when the egress proxy stops
 *  (e2b-egress.ts stopE2bEgress), whose port they all point at. */
export function closeProxiedFetches(): void {
  for (const entry of PROXIED.values()) void entry.then((e) => e.close()).catch(() => {});
  PROXIED.clear();
}

/** The egress proxy for a user's self-hosted E2B; none for E2B's cloud. */
export async function userE2bProxy(target: { apiUrl?: string; sandboxUrl?: string }): Promise<string | undefined> {
  if (!target.apiUrl && !target.sandboxUrl) return undefined;
  const { egressProxyFor, selfHostedE2bHosts } = await import("@/lib/runtime/sandbox/e2b-egress");
  return egressProxyFor(selfHostedE2bHosts(target, E2B_CLOUD_DOMAIN));
}
