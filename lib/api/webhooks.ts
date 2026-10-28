/**
 * Webhooks, the parts with no network: how an event is signed and checked,
 * which URLs may be told, when a failed delivery is tried again, and what a
 * watched session's latest turn means to tell (docs/api.md, "Webhooks").
 * lib/api/webhooks.deps.ts watches and delivers.
 *
 * A delivery is a POST of JSON with
 *
 *   Outrunner-Event: turn.completed
 *   Outrunner-Delivery: <its id, the same on every try>
 *   Outrunner-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * signed with the secret of whoever the session was started for (an org,
 * or a person), so a receiver checks it came from Outrunner, and recently.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const WEBHOOK_EVENTS = ["workspace.ready", "turn.completed", "needs_input", "pr.opened", "error"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** A signing secret, as the settings page shows it. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** The Outrunner-Signature header for `body`, sent at `timestamp` (seconds). */
export function signature(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** How long after it was signed a delivery still counts: five minutes. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Whether `header` is a signature of `body` with `secret`, made recently:
 *  what a receiver checks (docs/api.md shows it in a few lines). */
export function signatureMatches(
  secret: string,
  body: string,
  header: string | null,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signature(secret, body, timestamp).split("v1=")[1]);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Whether an address is one the server must not be made to call: loopback,
 * private, link-local (a cloud's metadata service), and the like. A webhook
 * goes only to the public internet.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true;
}

/**
 * A webhook URL as posted: https, a public host, no credentials in it, at
 * most 2000 characters. Null for none given; undefined for one refused. The
 * host's addresses are checked again as each delivery goes (a name can
 * point anywhere later).
 */
export function webhookUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return undefined;
  if (isIP(host) && isPrivateAddress(host)) return undefined;
  return url.toString();
}

/** Seconds to wait before each try after the first: about nine hours in all. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600] as const;

/** When a delivery tried `attempts` times is next tried, or null when it
 *  has had its tries and gives up. */
export function nextAttemptAt(attempts: number, now = Date.now()): string | null {
  const wait = BACKOFF_SECONDS[attempts - 1];
  return wait === undefined ? null : new Date(now + wait * 1000).toISOString();
}

/** What a watched session has shown of its turn so far (api_watches). */
export type WatchState = {
  awaiting: boolean;
  seenWorking: boolean;
  baselineEvent: string | null;
  askedToolUse: string | null;
};

/** The session's turn, as GET /workspaces/{id} says it. */
export type TurnView = {
  state: "working" | "needs_input" | "idle";
  last_event_id: string | null;
  pending_input: { tool_use_id?: string } | null;
};

/**
 * What a look at the session's turn means: the events to tell, and what to
 * remember. A turn has ended once it's idle after it was seen working, or
 * after the conversation moved on from where it was first seen (a turn too
 * quick to be caught working). A question is told once.
 */
export function watchStep(watch: WatchState, turn: TurnView | null): { events: WebhookEvent[]; next: WatchState } {
  if (!turn) return { events: [], next: watch };
  if (turn.state === "working") {
    return { events: [], next: { ...watch, seenWorking: true, askedToolUse: null } };
  }
  if (turn.state === "needs_input") {
    const asked = turn.pending_input?.tool_use_id ?? "asked";
    if (asked === watch.askedToolUse) return { events: [], next: watch };
    return { events: ["needs_input"], next: { ...watch, askedToolUse: asked } };
  }
  if (!watch.awaiting) return { events: [], next: watch };
  const movedOn = watch.baselineEvent !== null && turn.last_event_id !== watch.baselineEvent;
  if (watch.seenWorking || movedOn) {
    return { events: ["turn.completed"], next: { awaiting: false, seenWorking: false, baselineEvent: null, askedToolUse: null } };
  }
  return { events: [], next: { ...watch, baselineEvent: watch.baselineEvent ?? turn.last_event_id ?? "" } };
}

/** An event as it's delivered. */
export function eventBody(input: {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  workspace: Record<string, unknown> | null;
  data: Record<string, unknown>;
}): Record<string, unknown> {
  return { id: input.id, type: input.event, created_at: input.createdAt, workspace: input.workspace, data: input.data };
}
