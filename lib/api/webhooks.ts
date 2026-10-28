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

/** An IPv6 address's eight groups, or null for one that doesn't parse. An
 *  IPv4 tail ("::ffff:1.2.3.4") is read as its two groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** The IPv4 address in an IPv6 address's last 32 bits. */
function embeddedV4(groups: number[]): string {
  return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
}

/**
 * Whether an address is one the server must not be made to call: loopback,
 * private, link-local (a cloud's metadata service), and the like. A webhook
 * goes only to the public internet. An IPv6 address that carries an IPv4
 * one (mapped, compatible) is judged by it, in whatever form it's written:
 * the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1. NAT64 and 6to4,
 * which reach IPv4 addresses through a gateway, are refused outright.
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
    const g = ipv6Groups(address);
    if (!g) return true;
    const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated).
    if (zeroTo(5) && g[5] === 0xffff) return isPrivateAddress(embeddedV4(g));
    if (zeroTo(6)) return g[6] === 0 && g[7] <= 1 ? true : isPrivateAddress(embeddedV4(g));
    // NAT64 (64:ff9b::/96, and the local-use 64:ff9b:1::/48) and 6to4.
    if (g[0] === 0x64 && g[1] === 0xff9b) return true;
    if (g[0] === 0x2002) return true;
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
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
  /** Whether a prompt is in the log past the watch's baseline (promptSince):
   *  the log moving on counts as a turn only then. */
  prompted?: boolean;
};

/**
 * What a look at the session's turn means: the events to tell, and what to
 * remember. A turn has ended once it's idle after it was seen working, or
 * after the conversation moved on from its baseline (a turn too quick to be
 * caught working). The baseline is where the log stood before the prompt
 * (the send's fence, or an empty log for a session's first); with none
 * known, it's where the first look finds the log. A question is told once.
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
  // An empty log reads as "0", on both sides, so two looks at nothing are
  // never taken for the log moving on.
  const at = turn.last_event_id ?? EMPTY_LOG;
  const movedOn = watch.baselineEvent !== null && at !== watch.baselineEvent && turn.prompted !== false;
  if (watch.seenWorking || movedOn) {
    return { events: ["turn.completed"], next: { awaiting: false, seenWorking: false, baselineEvent: null, askedToolUse: null } };
  }
  return { events: [], next: { ...watch, baselineEvent: watch.baselineEvent ?? at } };
}

/** Where a log with no events stands, as a watch's baseline. */
export const EMPTY_LOG = "0";

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
