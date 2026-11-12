/**
 * How this server reaches a port in an E2B sandbox: E2B's client-proxy (the
 * deployment's OUTRUNNER_E2B_SANDBOX_URL) routes a request by two headers naming the
 * sandbox and the port, so one base URL serves every box. A browser can't set
 * them, so its WebSockets come through this server's relay (relay.ts).
 *
 * Imports nothing from the app: the custom server loads it as is.
 */

export const E2B_SANDBOX_ID_HEADER = "E2b-Sandbox-Id";
export const E2B_SANDBOX_PORT_HEADER = "E2b-Sandbox-Port";
/** A box made with allowPublicTraffic: false answers only requests carrying
 *  its traffic access token, here, on every port. */
export const E2B_TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

/** The base URL and headers that reach `port` in sandbox `sandboxId`, with
 *  its traffic token when it has one. Throws when E2B isn't configured here,
 *  rather than route somewhere else. */
export function e2bRoute(
  sandboxId: string,
  port: number,
  sandboxUrl = process.env.OUTRUNNER_E2B_SANDBOX_URL,
  trafficToken?: string,
): { base: string; headers: Record<string, string> } {
  if (!sandboxUrl) throw new Error("OUTRUNNER_E2B_SANDBOX_URL is not set.");
  return {
    base: sandboxUrl.replace(/\/+$/, ""),
    headers: {
      [E2B_SANDBOX_ID_HEADER]: sandboxId,
      [E2B_SANDBOX_PORT_HEADER]: String(port),
      ...(trafficToken ? { [E2B_TRAFFIC_TOKEN_HEADER]: trafficToken } : {}),
    },
  };
}

/**
 * What a relay ticket to an E2B box carries sealed (relay-ticket.ts): the
 * box's traffic token, and for a box in a user's E2B, whose it is, so the
 * relay asks for that user's box and no one else's that shares its id.
 */
export type E2bRelaySecret = { token?: string; owner?: string };

export function sealableE2bRelaySecret(secret: E2bRelaySecret): string | undefined {
  if (!secret.token && !secret.owner) return undefined;
  return JSON.stringify({ t: secret.token, o: secret.owner });
}

/** The secret a ticket carried; empty for one with none, or a bad one. */
export function readE2bRelaySecret(sealed: string | undefined): E2bRelaySecret {
  if (!sealed) return {};
  try {
    const parsed = JSON.parse(sealed) as { t?: unknown; o?: unknown };
    return {
      ...(typeof parsed.t === "string" && parsed.t ? { token: parsed.t } : {}),
      ...(typeof parsed.o === "string" && parsed.o ? { owner: parsed.o } : {}),
    };
  } catch {
    return {};
  }
}
