import http, { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

import {
  PREVIEW_PATH_PREFIX,
  type PreviewDomain,
  isOriginFormPath,
  onPreviewDomain,
  previewCookieName,
  previewOrigin,
  safeReturnPath,
  slugFromHost,
} from "./host.ts";
import { PAGE_HEADERS, renderPreviewPage } from "./proxy-pages.ts";
import type { GateDecision, GateRequest, PreviewUpstream, RedeemAnswer, WakeAnswer } from "./wire.ts";

/**
 * Previews' front door, in the custom server (server.ts) ahead of Next: a
 * request whose host is a preview's (`<slug>.<RUNTIME_PREVIEW_DOMAIN>`)
 * never reaches the app. The app's gate (app/api/previews/gate) says what to
 * do with each visitor; this does it, and passes everything else, bytes as
 * they are, to the server on the box: pages, assets, server-sent events,
 * and WebSockets (a dev server's hot reload among them), so nothing about
 * the user's server need know it's behind Outrunner.
 *
 * In front of the box, it:
 * - signs a visitor in (`/__outrunner/auth`, a ticket from the app's
 *   /previews/<slug>, traded for a cookie kept to this one host), and keeps
 *   that cookie to itself: the box's server never sees it, nor can set it;
 * - tells the box's server where the request came to (`X-Forwarded-Host`,
 *   `-Proto`, `-Port`, `-For`, `Forwarded`), and sends it the preview's own
 *   Host where the way in goes straight to the port (Neev's tunnel); through
 *   a provider's proxy, which routes by Host (Daytona's), the proxy's;
 * - passes the path and query on exactly as asked, so an OAuth provider's
 *   or a webhook's callback arrives as sent;
 * - points a redirect the box's server made to the provider's host back at
 *   the preview's, and keeps every cookie it sets to the preview's host.
 *
 * Node runs this as is for the server: it imports nothing from the app.
 */

export type PreviewProxyDeps = {
  /** The preview domain, or null when previews are off (lib/previews/host.ts). */
  domain: () => PreviewDomain | null;
  /** The app's own host (RUNTIME_BASE_URL's), which is never a preview's
   *  whatever a request's headers say. */
  appHost: () => string | null;
  /** Whether a host named in `x-outrunner-preview-host` was named by the
   *  Cloudflare Worker: its signature (cloudflare/preview-host.ts) checks. */
  edgeNamed: (host: string, signature: string | undefined) => boolean;
  /** Whether a session cookie is well signed for `slug` (lib/previews/tokens.ts):
   *  one that isn't is no session, and costs the gate nothing. */
  sessionValid: (slug: string, session: string) => boolean;
  /** Ask the app's gate (wire.ts); a throw is an app that didn't answer. */
  gate: (request: GateRequest) => Promise<unknown>;
  now?: () => number;
};

/** Hop-by-hop headers (RFC 9110 §7.6.1), the connection's, never passed on. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers of the edge in front of this server, or of the provider's
 *  proxy, which the box's server has no business being sent by a visitor. */
function edgeHeader(name: string): boolean {
  return name.startsWith("cf-") || name.startsWith("x-daytona-") || name.startsWith("x-outrunner-preview-host") || name === "cdn-loop";
}

/** A request's preview: its slug, the domain, its host, and whether the
 *  Cloudflare Worker passed it on (whose word on the visitor's address is
 *  then believed). */
type Preview = { slug: string; domain: PreviewDomain; host: string; edge: boolean };

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

/** The cache's most entries: a visitor and their cookie, each. */
const MAX_DECISIONS = 5_000;

export function createPreviewProxy(deps: PreviewProxyDeps) {
  const now = deps.now ?? Date.now;
  const decisions = new Map<string, { until: number; decision: Promise<GateDecision> }>();

  /** What the gate says of `slug` and `session`, kept as long as it says to:
   *  a page's dozens of assets ask once between them. */
  function decide(slug: string, cookie: string | null): Promise<GateDecision> {
    const session = cookie && deps.sessionValid(slug, cookie) ? cookie : null;
    const key = `${slug}\n${session ?? ""}`;
    const kept = decisions.get(key);
    if (kept && kept.until > now()) return kept.decision;
    const decision = deps.gate({ op: "resolve", slug, session }).then((answer) => answer as GateDecision);
    if (decisions.size >= MAX_DECISIONS) {
      for (const [k, v] of decisions) if (v.until <= now()) decisions.delete(k);
      // Still full: the oldest go (a Map keeps the order they came in).
      for (const k of decisions.keys()) {
        if (decisions.size < MAX_DECISIONS) break;
        decisions.delete(k);
      }
    }
    decisions.delete(key);
    // Held while asked, so requests meanwhile wait on the same answer, then
    // for as long as the answer says; a failure isn't kept.
    decisions.set(key, { until: now() + 60_000, decision });
    decision.then(
      (d) => {
        if (decisions.get(key)?.decision === decision) decisions.set(key, { until: now() + d.ttlMs, decision });
      },
      () => {
        if (decisions.get(key)?.decision === decision) decisions.delete(key);
      },
    );
    return decision;
  }

  /** Drop every answer kept for `slug`: its link to the box was expired,
   *  or it was deleted (lib/previews/forget.ts). */
  function forget(slug: string): void {
    for (const key of decisions.keys()) if (key.startsWith(`${slug}\n`)) decisions.delete(key);
  }

  /** The preview a request is for, and its domain; "none" for a host under
   *  the preview domain that names no preview; null for the app's own. */
  function previewOf(req: IncomingMessage): Preview | "none" | null {
    const domain = deps.domain();
    if (!domain) return null;
    // The Cloudflare Worker names the host it was asked for, signed
    // (cloudflare/preview-host.ts), since the container may not see it as
    // the Host. A name without the Worker's signature (a visitor's own,
    // straight to Node) is ignored, as is one off the preview domain, and
    // any on the app's own host: a preview's page there would be the app's.
    const named = req.headers["x-outrunner-preview-host"];
    const signature = req.headers["x-outrunner-preview-host-signature"];
    const own = (req.headers.host ?? "").toLowerCase() === deps.appHost()?.toLowerCase();
    const edge =
      !own &&
      typeof named === "string" &&
      onPreviewDomain(named, domain) &&
      deps.edgeNamed(named.toLowerCase(), typeof signature === "string" ? signature : undefined);
    const host = edge ? named : req.headers.host;
    const slug = slugFromHost(host, domain);
    if (slug) return { slug, domain, host: `${slug}.${domain.host}`, edge };
    return onPreviewDomain(host, domain) ? "none" : null;
  }

  /** Take a request for a preview; false for anything else, for Next. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const found = previewOf(req);
    if (!found) return false;
    if (found === "none") {
      sendPage(res, 404, "missing");
      return true;
    }
    void serve(req, res, found).catch((error: unknown) => {
      console.error(`Preview ${found.slug}: request failed`, error);
      if (!res.headersSent) sendPage(res, 502, "error");
      else res.destroy();
    });
    return true;
  }

  async function serve(req: IncomingMessage, res: ServerResponse, at: Preview) {
    if (!isOriginFormPath(req.url)) return sendText(res, 400, "Bad request.");
    const path = req.url;
    if (path.startsWith(PREVIEW_PATH_PREFIX)) return own(req, res, at, path);

    const session = readCookie(req.headers.cookie, previewCookieName(at.domain));
    let decision: GateDecision;
    try {
      decision = await decide(at.slug, session);
    } catch (error) {
      console.error(`Preview ${at.slug}: the gate didn't answer`, error);
      return sendPage(res, 503, "error", { path });
    }
    if (decision.kind === "login") {
      if (!navigates(req)) return sendText(res, 401, "Sign in to Outrunner to open this preview.");
      return redirect(res, `${decision.signInUrl}?r=${encodeURIComponent(safeReturnPath(path))}`);
    }
    if (decision.kind === "page") return sendPage(res, decision.status, decision.page, { canWake: decision.canWake, path });
    forward(req, res, at, decision, path);
  }

  /** Outrunner's own paths on a preview's host. */
  async function own(req: IncomingMessage, res: ServerResponse, at: Preview, path: string) {
    const url = new URL(path, "http://preview");
    const back = safeReturnPath(url.searchParams.get("r"));
    const cookieName = previewCookieName(at.domain);

    if (url.pathname === `${PREVIEW_PATH_PREFIX}auth` && (req.method === "GET" || req.method === "HEAD")) {
      const ticket = url.searchParams.get("ticket") ?? "";
      const answer = (await deps.gate({ op: "redeem", slug: at.slug, ticket })) as RedeemAnswer;
      if (!answer.ok) {
        const signInUrl = await deps
          .gate({ op: "resolve", slug: at.slug, session: null })
          .then((d) => ((d as GateDecision).kind === "login" ? (d as Extract<GateDecision, { kind: "login" }>).signInUrl : undefined))
          .catch(() => undefined);
        return sendPage(res, 401, "expired", { path: back, signInUrl });
      }
      const secure = at.domain.secure ? "; Secure" : "";
      res.writeHead(303, {
        location: back,
        "set-cookie": `${cookieName}=${answer.cookie}; Path=/; Max-Age=${answer.maxAge}; HttpOnly; SameSite=Lax${secure}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      return res.end();
    }

    if (url.pathname === `${PREVIEW_PATH_PREFIX}wake` && req.method === "POST") {
      // A form on the asleep page, this host's own: a page elsewhere can't
      // make the owner's browser wake (and pay for) the session.
      if (req.headers.origin !== previewOrigin(at.slug, at.domain)) return sendText(res, 403, "Wake from the preview's own page.");
      const session = readCookie(req.headers.cookie, cookieName);
      const answer = (await deps.gate({ op: "wake", slug: at.slug, session })) as WakeAnswer;
      decisions.delete(`${at.slug}\n${session ?? ""}`);
      if (!answer.ok) return sendPage(res, 409, "asleep", { path: back, message: answer.message });
      return sendPage(res, 202, "woke", { path: back });
    }

    sendText(res, 404, "Not found.");
  }

  /** Pass the request to the box's server, and its answer back. */
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    at: Preview,
    { upstream, mode }: Extract<GateDecision, { kind: "proxy" }>,
    path: string,
  ) {
    const target = new URL(upstream.baseUrl);
    const client = target.protocol === "https:" ? https : http;
    const outbound = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: joinPath(target.pathname, path),
      headers: forwardHeaders(req, at, upstream, false),
      // Kept alive: a page's assets would otherwise each cost a TLS
      // handshake with the provider. A connection carries nothing of a
      // visitor's past one request, the provider's credential going on each.
      agent: target.protocol === "https:" ? httpsAgent : httpAgent,
    });
    outbound.on("response", (answer) => {
      const headers = responseHeaders(answer.headers, at, target);
      // What a signed-in visitor was let see is theirs: no cache between
      // them and here may keep it for the next.
      if (mode === "login") headers["cache-control"] = privateCaching(headers["cache-control"]);
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
      answer.pipe(res);
      answer.on("error", () => res.destroy());
    });
    outbound.on("error", (error) => {
      if (!res.headersSent) {
        console.error(`Preview ${at.slug}: the box didn't answer`, error.message);
        sendPage(res, 502, "unavailable", { path });
      } else {
        res.destroy();
      }
    });
    // The visitor gave up (a closed tab, a cancelled fetch): so does the box.
    res.on("close", () => {
      if (!res.writableFinished) outbound.destroy();
    });
    req.pipe(outbound);
  }

  /** Take a WebSocket upgrade for a preview; false for anything else. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const found = previewOf(req);
    if (!found) return false;
    if (found === "none") {
      refuse(socket, 404);
      return true;
    }
    void tunnel(req, socket, head, found).catch((error: unknown) => {
      console.error(`Preview ${found.slug}: WebSocket failed`, error);
      refuse(socket, 502);
    });
    return true;
  }

  async function tunnel(req: IncomingMessage, socket: Duplex, head: Buffer, at: Preview) {
    if (!isOriginFormPath(req.url) || req.url.startsWith(PREVIEW_PATH_PREFIX)) return refuse(socket, 404);
    const path = req.url;
    const session = readCookie(req.headers.cookie, previewCookieName(at.domain));
    let decision: GateDecision;
    try {
      decision = await decide(at.slug, session);
    } catch {
      return refuse(socket, 503);
    }
    if (decision.kind === "login") return refuse(socket, 401);
    if (decision.kind === "page") return refuse(socket, decision.status);
    if (socket.destroyed) return;

    const target = new URL(decision.upstream.baseUrl);
    const client = target.protocol === "https:" ? https : http;
    const outbound = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: joinPath(target.pathname, path),
      headers: forwardHeaders(req, at, decision.upstream, true),
      // Its own connection, which the WebSocket then takes over.
      agent: false,
    });
    const abandon = () => outbound.destroy();
    socket.once("close", abandon);
    socket.on("error", () => outbound.destroy());

    outbound.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
      socket.off("close", abandon);
      const lines = [`HTTP/1.1 101 ${answer.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        const name = answer.rawHeaders[i]!;
        const lower = name.toLowerCase();
        // Connection and Upgrade are this answer's to give, as the box did.
        if ((HOP_BY_HOP.has(lower) && lower !== "connection" && lower !== "upgrade") || edgeHeader(lower)) continue;
        if (lower === "set-cookie") {
          const cookie = rewriteSetCookie(answer.rawHeaders[i + 1]!, at);
          if (cookie) lines.push(`${name}: ${cookie}`);
          continue;
        }
        lines.push(`${name}: ${answer.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.setNoDelay(true);
      upstreamSocket.setTimeout(0);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
    });
    // The box's server answered without upgrading (a 404, a 400 for a bad
    // handshake): the browser hears that answer.
    outbound.on("response", (answer) => {
      socket.off("close", abandon);
      const status = answer.statusCode ?? 502;
      const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, "Connection: close"];
      for (const [name, value] of Object.entries(responseHeaders(answer.headers, at, target))) {
        if (name === "content-length") continue;
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      answer.pipe(socket);
    });
    outbound.on("error", () => refuse(socket, 502));
    outbound.end();
  }

  return { handle, upgrade, forget };
}

/**
 * The headers the box's server is sent: the visitor's, but the connection's
 * own, the edge's, and the preview's cookie; where the request came to; and
 * the provider's credential, last, so a visitor can't send their own.
 */
export function forwardHeaders(
  req: Pick<IncomingMessage, "headers" | "socket">,
  at: { domain: PreviewDomain; host: string; edge?: boolean },
  upstream: PreviewUpstream,
  upgrading: boolean,
): Record<string, string | string[]> {
  const named = new Set(
    String(req.headers.connection ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (edgeHeader(name) || name === "host" || name === "cookie") continue;
    if (name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-real-ip") continue;
    if ((HOP_BY_HOP.has(name) || named.has(name)) && !(upgrading && (name === "upgrade" || name === "connection"))) continue;
    out[name] = value;
  }
  if (upgrading) {
    out.connection = "Upgrade";
    out.upgrade = String(req.headers.upgrade ?? "websocket");
  }
  const cookie = stripCookie(req.headers.cookie, previewCookieName(at.domain));
  if (cookie) out.cookie = cookie;

  const proto = at.domain.secure ? "https" : "http";
  const port = /:(\d+)$/.exec(at.host)?.[1] ?? (at.domain.secure ? "443" : "80");
  // The visitor's address: Cloudflare's word for it where the Worker passed
  // the request on (it has already added it to X-Forwarded-For), else the
  // connection's. Straight to Node, a CF-Connecting-IP is the visitor's own.
  const edgeClient = at.edge && typeof req.headers["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"] : null;
  const client = edgeClient ?? req.socket.remoteAddress ?? "";
  const before = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
  const chain = edgeClient ? before || client : [before, client].filter(Boolean).join(", ");
  out["x-forwarded-for"] = chain;
  out["x-forwarded-host"] = at.host;
  out["x-forwarded-proto"] = proto;
  out["x-forwarded-port"] = port;
  out["x-real-ip"] = client;
  out.forwarded = `for=${forwardedNode(client)};host="${at.host}";proto=${proto}`;

  out.host = upstream.hostHeader === "preview" ? at.host : new URL(upstream.baseUrl).host;
  for (const [name, value] of Object.entries(upstream.headers)) out[name.toLowerCase()] = value;
  return out;
}

/** A Forwarded `for=` node: an IPv6 address quoted and bracketed. */
function forwardedNode(address: string): string {
  if (!address) return "unknown";
  return address.includes(":") ? `"[${address}]"` : address;
}

/** The headers the visitor is sent back: the box's, but the connection's
 *  own; a redirect to the provider's host pointed at the preview's; and
 *  cookies kept to the preview's host, never its own session's. */
export function responseHeaders(
  headers: IncomingHttpHeaders,
  at: { domain: PreviewDomain; host: string },
  target: URL,
): Record<string, string | string[]> {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || edgeHeader(name)) continue;
    if (name === "location" && typeof value === "string") {
      out.location = rewriteLocation(value, at, target);
      continue;
    }
    if (name === "set-cookie") {
      const cookies = (Array.isArray(value) ? value : [value]).map((c) => rewriteSetCookie(c, at)).filter((c): c is string => !!c);
      if (cookies.length) out["set-cookie"] = cookies;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** A Cache-Control that keeps a response out of shared caches. */
export function privateCaching(value: string | string[] | undefined): string {
  const given = (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();
  if (!given) return "private";
  if (/\b(private|no-store)\b/i.test(given)) return given;
  const rest = given
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !/^(public|s-maxage=)/i.test(d));
  return ["private", ...rest].join(", ");
}

/** A redirect to the provider's host goes to the preview's instead. */
export function rewriteLocation(location: string, at: { domain: PreviewDomain; host: string }, target: URL): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative: the browser resolves it against the preview
  }
  if (url.host !== target.host) return location;
  return `${at.domain.secure ? "https" : "http"}://${at.host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * A cookie the box's server sets: dropped if it's named as the preview's
 * session, and kept to the preview's own host whatever Domain it names. One
 * made for the provider's host would otherwise be lost, and one for the
 * preview domain as a whole would reach every other preview.
 */
export function rewriteSetCookie(cookie: string, at: { domain: PreviewDomain }): string | null {
  const name = cookie.split("=", 1)[0]!.trim();
  if (name.toLowerCase() === previewCookieName(at.domain).toLowerCase()) return null;
  return cookie
    .split(";")
    .filter((part, i) => i === 0 || part.split("=", 1)[0]!.trim().toLowerCase() !== "domain")
    .join(";");
}

/** A path under the base's (a provider whose way in has one). */
function joinPath(base: string, path: string): string {
  if (!base || base === "/") return path;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** The value of cookie `name` in a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** A Cookie header without cookie `name`; null when nothing's left. */
export function stripCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=", 1)[0]!.trim() !== name);
  return kept.length ? kept.join("; ") : null;
}

/** Whether a request is a page load, which may be sent to sign in; a
 *  script's fetch or an asset gets a plain 401 instead. */
function navigates(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  return String(req.headers.accept ?? "").includes("text/html");
}

function sendPage(res: ServerResponse, status: number, page: Parameters<typeof renderPreviewPage>[0], options: Parameters<typeof renderPreviewPage>[1] = {}) {
  res.writeHead(status, PAGE_HEADERS);
  res.end(renderPreviewPage(page, options));
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
}

/** Answer an upgrade with a plain HTTP status and hang up. */
function refuse(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

/** The gate, over the loopback to this same server's Next (server.ts). */
export function loopbackGate(port: number, secret: string, header: string, path: string) {
  return async (request: GateRequest): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [header]: secret },
      body: JSON.stringify(request),
      // Waking a session starts its box; the rest is a few reads.
      signal: AbortSignal.timeout(request.op === "wake" ? 70_000 : 15_000),
    });
    if (!response.ok) throw new Error(`The preview gate answered ${response.status}`);
    return response.json();
  };
}
