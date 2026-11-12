import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
 * A ticket may also carry a secret the relay needs on its own connection
 * (E2B's per-box traffic token): `<exp>.<sig>.<sealed>`, sealed with
 * AES-256-GCM under the same key, so the browser holding the ticket can't
 * read it, and covered by the signature.
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

function signature(sandboxId: string, port: number, exp: number, key: string, sealed?: string): string {
  // "neev-relay" for every provider: the key, not this label, keeps them apart,
  // and changing it would void tickets already handed out.
  const signed = `neev-relay:${sandboxId}:${port}:${exp}${sealed ? `:${sealed}` : ""}`;
  return createHmac("sha256", key).update(signed).digest("base64url");
}

/** The AES key a ticket's secret is sealed under: derived from the ticket key. */
function sealKey(key: string): Buffer {
  return createHash("sha256").update(`outrunner:relay-seal:v1:${key}`).digest();
}

function seal(secret: string, aad: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(key), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

function unseal(sealed: string, aad: string, key: string): string | null {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 12 + 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(key), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A ticket for `port` of `sandboxId`, good for `ttlSeconds`: the agent's
 *  for an hour, a desktop link's for the minutes it takes to open its socket.
 *  `secret`, when given, rides along sealed for the relay alone. */
export function mintRelayTicket(
  sandboxId: string,
  port: number,
  key: string,
  now = Date.now(),
  { secret, ttlSeconds = RELAY_TICKET_TTL_SECONDS }: { secret?: string; ttlSeconds?: number } = {},
): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  if (!secret) return `${exp}.${signature(sandboxId, port, exp, key)}`;
  const sealed = seal(secret, `${sandboxId}:${port}:${exp}`, key);
  return `${exp}.${signature(sandboxId, port, exp, key, sealed)}.${sealed}`;
}

/** What a valid, unexpired ticket for `port` of `sandboxId` carries (its
 *  sealed secret, if any); null for any other ticket. */
export function openRelayTicket(
  ticket: string,
  sandboxId: string,
  port: number,
  key: string,
  now = Date.now(),
): { secret?: string } | null {
  const [expText, sig, sealed, ...rest] = ticket.split(".");
  const exp = Number(expText);
  if (rest.length > 0 || !sig || sealed === "" || !Number.isSafeInteger(exp) || exp < now / 1000) return null;
  const expected = Buffer.from(signature(sandboxId, port, exp, key, sealed));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (sealed === undefined) return {};
  const secret = unseal(sealed, `${sandboxId}:${port}:${exp}`, key);
  return secret === null ? null : { secret };
}

export function relayTicketValid(
  ticket: string,
  sandboxId: string,
  port: number,
  key: string,
  now = Date.now(),
): boolean {
  return openRelayTicket(ticket, sandboxId, port, key, now) !== null;
}
