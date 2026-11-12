import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The browser's pass through this server's relay (relay.ts) to one port of
 * one sandbox, on any provider whose boxes a browser can't reach directly
 * (Neev, a user's GCP, E2B: the deployment's or a user's own). The relay serves `<prefix><sandbox>/<port>/<ticket>/`,
 * and the ticket is `<exp>.<sig>`: an HMAC of the sandbox, the port and the
 * expiry under a key only this server holds (the project's Neev API key, or
 * {@link relayKey} of the credentials key). The agent still checks its own
 * Runtime token on every connection; the ticket keeps the relay from opening
 * a way into a sandbox for anyone who names one.
 *
 * Imports nothing from the app: the custom server loads it as is.
 */

export const NEEV_RELAY_PREFIX = "/relay/neev/";
export const E2B_RELAY_PREFIX = "/relay/e2b/";
export const USER_E2B_RELAY_PREFIX = "/relay/user-e2b/";

/** Longer than a Runtime token's 5 minutes, which a reconnect needs anyway. */
export const RELAY_TICKET_TTL_SECONDS = 60 * 60;

/** A provider's own relay key, derived from `secret` (the credentials key),
 *  so a ticket for one provider's relay opens nothing on another's. The
 *  label is fixed per provider: changing it voids tickets already handed out. */
export function relayKey(secret: string, provider: "gcp" | "e2b" | "user-e2b"): string {
  return createHmac("sha256", secret).update(`outrunner:${provider}-relay:v1`).digest("base64url");
}

function signature(sandboxId: string, port: number, exp: number, key: string): string {
  // "neev-relay" for every provider: the key, not this label, keeps them apart,
  // and changing it would void tickets already handed out.
  return createHmac("sha256", key).update(`neev-relay:${sandboxId}:${port}:${exp}`).digest("base64url");
}

/** A ticket for `port` of `sandboxId`, good for `ttlSeconds`: the agent's
 *  for an hour, a desktop link's for the minutes it takes to open its socket. */
export function mintRelayTicket(
  sandboxId: string,
  port: number,
  key: string,
  now = Date.now(),
  ttlSeconds = RELAY_TICKET_TTL_SECONDS,
): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `${exp}.${signature(sandboxId, port, exp, key)}`;
}

export function relayTicketValid(
  ticket: string,
  sandboxId: string,
  port: number,
  key: string,
  now = Date.now(),
): boolean {
  const [expText, sig, ...rest] = ticket.split(".");
  const exp = Number(expText);
  if (rest.length > 0 || !sig || !Number.isSafeInteger(exp) || exp < now / 1000) return false;
  const expected = Buffer.from(signature(sandboxId, port, exp, key));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
