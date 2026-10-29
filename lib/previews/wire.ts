/**
 * What the preview proxy (lib/previews/proxy.ts, in the custom server) and
 * the app's gate (app/api/previews/gate, lib/previews/resolve.ts) say to
 * each other over the loopback. The proxy holds no database or provider
 * code; it asks the gate what to do with each visitor, a few seconds at a
 * time. Types alone, so Node runs it as is for the server.
 */

/** Where the proxy sends a preview's requests: a base URL, the headers
 *  that get them through the provider (its credential among them), and
 *  which host the box's server is told (PreviewTarget). */
export type PreviewUpstream = {
  baseUrl: string;
  headers: Record<string, string>;
  hostHeader: "preview" | "upstream";
};

/** One of the pages the proxy shows in place of the box's (proxy-pages.ts). */
export type PreviewPage = "missing" | "ended" | "denied" | "asleep" | "starting" | "unsupported" | "unavailable" | "error";

export type GateDecision =
  /** Let the visitor through to the box. */
  | { kind: "proxy"; upstream: PreviewUpstream; mode: "login" | "public"; ttlMs: number }
  /** Send the visitor to sign in: to `signInUrl`, with the path to come
   *  back to as `r`. */
  | { kind: "login"; signInUrl: string; ttlMs: number }
  /** Show a page of Outrunner's instead: the preview is gone, the visitor
   *  may not see it, the session is asleep. `canWake` offers to wake it. */
  | { kind: "page"; status: number; page: PreviewPage; canWake?: boolean; ttlMs: number };

export type GateRequest =
  | { op: "resolve"; slug: string; session: string | null }
  | { op: "redeem"; slug: string; ticket: string }
  | { op: "wake"; slug: string; session: string | null };

export type RedeemAnswer = { ok: true; cookie: string; maxAge: number } | { ok: false };
export type WakeAnswer = { ok: boolean; message?: string };

/** The header the proxy proves itself with: a secret made for the process
 *  at start (server.ts), never sent anywhere but the loopback. */
export const GATE_SECRET_HEADER = "x-outrunner-preview-gate";
export const GATE_SECRET_ENV = "OUTRUNNER_PREVIEW_GATE_SECRET";
export const GATE_PATH = "/api/previews/gate";
