import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The browser's pass through this server's relay (neev-relay.ts) to one port
 * of one Neev sandbox. The relay serves `<prefix><sandbox>/<port>/<ticket>/`,
 * and the ticket is `<exp>.<sig>`: an HMAC of the sandbox, the port and the
 * expiry under the project's Neev API key, which only this server holds. The
 * agent still checks its own Runtime token on every connection; the ticket
 * keeps the relay from opening a way into a sandbox for anyone who names one.
 *
 * Imports nothing from the app: the custom server loads it as is.
 */

export const NEEV_RELAY_PREFIX = "/relay/neev/";

/** Longer than a Runtime token's 5 minutes, which a reconnect needs anyway. */
export const RELAY_TICKET_TTL_SECONDS = 60 * 60;

function signature(sandboxId: string, port: number, exp: number, key: string): string {
  return createHmac("sha256", key).update(`neev-relay:${sandboxId}:${port}:${exp}`).digest("base64url");
}

export function mintRelayTicket(sandboxId: string, port: number, key: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + RELAY_TICKET_TTL_SECONDS;
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
