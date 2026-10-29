/**
 * What signs a visitor in to a login preview. The visitor's Outrunner
 * sign-in is the app's, on the app's host; the preview is on a site of its
 * own (lib/previews/host.ts), which can't read it. So the app, having
 * checked who they are and that they may see it, sends them to the preview
 * with a ticket: good for a minute, for that preview alone, and once. The
 * preview's host trades it for a session cookie of its own, kept to that
 * host, which says who the visitor is for a working day. Neither is the
 * last word on access: every request is checked against the preview and
 * the visitor's access as they stand (lib/previews/resolve.ts).
 *
 * Both are `<payload>.<signature>`: the payload base64url JSON, the
 * signature an HMAC-SHA256 under a key derived from
 * CREDENTIALS_ENCRYPTION_KEY, over what the token is for and the payload,
 * so a ticket is never a session nor a session a ticket.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a ticket can be redeemed. */
export const TICKET_TTL_SECONDS = 60;
/** How long a preview session lasts before signing in again. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

type Purpose = "ticket" | "session";

type Payload = { s: string; u: string; e: number; n: string };

/** The signing key, derived so it signs nothing else's. */
export function previewSigningKey(credentialsKey: string): Buffer {
  return createHmac("sha256", credentialsKey).update("outrunner preview signing v1").digest();
}

function sign(key: Buffer, purpose: Purpose, payload: string): string {
  return createHmac("sha256", key).update(`${purpose}\n${payload}`).digest("base64url");
}

function mint(key: Buffer, purpose: Purpose, slug: string, userId: string, ttl: number, now: number): string {
  const payload: Payload = { s: slug, u: userId, e: Math.floor(now / 1000) + ttl, n: randomBytes(12).toString("base64url") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(key, purpose, encoded)}`;
}

/** The token's payload, if it's a well-signed, unexpired one for `slug`. */
function read(key: Buffer, purpose: Purpose, token: string | null | undefined, slug: string, now: number): Payload | null {
  if (!token || token.length > 1024) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(key, purpose, encoded));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    return null;
  }
  if (payload.s !== slug || typeof payload.u !== "string" || typeof payload.n !== "string") return null;
  if (typeof payload.e !== "number" || payload.e * 1000 <= now) return null;
  return payload as Payload;
}

export function mintTicket(key: Buffer, slug: string, userId: string, now = Date.now()): string {
  return mint(key, "ticket", slug, userId, TICKET_TTL_SECONDS, now);
}

export function mintSession(key: Buffer, slug: string, userId: string, now = Date.now()): string {
  return mint(key, "session", slug, userId, SESSION_TTL_SECONDS, now);
}

/** The signature the Cloudflare Worker sends with a preview's host it
 *  names (cloudflare/preview-host.ts signPreviewHost, which this matches):
 *  the proxy believes a named host only with it. */
export function edgeHostSignature(credentialsKey: string, host: string): string {
  return createHmac("sha256", credentialsKey).update(`outrunner preview host\n${host}`).digest("base64url");
}

/** Whether `signature` is the Worker's for `host`. */
export function edgeHostSigned(credentialsKey: string, host: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(edgeHostSignature(credentialsKey, host));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Who a session cookie signs in, for `slug`; null for none, or a bad one. */
export function sessionUser(key: Buffer, token: string | null | undefined, slug: string, now = Date.now()): string | null {
  return read(key, "session", token, slug, now)?.u ?? null;
}

/**
 * Tickets already redeemed, until they'd have expired anyway: one overheard
 * (a browser's history, a log) can't sign anyone in again. Kept in this
 * process, which is the one the proxy runs in.
 */
export class TicketLedger {
  private readonly spent = new Map<string, number>();

  /** Who the ticket signs in, spending it; null for a bad, expired or spent one. */
  redeem(key: Buffer, ticket: string | null | undefined, slug: string, now = Date.now()): string | null {
    const payload = read(key, "ticket", ticket, slug, now);
    if (!payload) return null;
    for (const [nonce, expires] of this.spent) if (expires <= now) this.spent.delete(nonce);
    if (this.spent.has(payload.n)) return null;
    this.spent.set(payload.n, payload.e * 1000);
    return payload.u;
  }
}
