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
export function e2bSdkOptions(target: { apiKey: string; apiUrl?: string; sandboxUrl?: string }, requestTimeoutMs = 2 * 60 * 1000) {
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
  };
}
