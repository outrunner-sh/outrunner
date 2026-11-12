import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";

import { publicOnlyLookup } from "@/lib/api/webhook-lookup";

/**
 * Where the E2B SDK's calls to a user's self-hosted E2B may go. The SDK has no
 * way to refuse redirects (it follows them, X-API-Key and all) or to pin the
 * address it connects to, but it does take a proxy, which it tunnels every
 * request through (CONNECT), redirects included. So it's given this one: a
 * CONNECT proxy on loopback that opens a tunnel only to the hosts the user
 * configured, each resolved public-only in the same lookup the socket uses.
 * A redirect elsewhere (another host, an internal address) fails to connect,
 * so the user's key never leaves for it, and DNS that answers public for a
 * check and private after (rebinding) gets nowhere.
 *
 * The hosts a tunnel may reach ride in the proxy URL's user name, signed with
 * a key only this process holds, so one proxy serves every user, and a proxy
 * URL can't be made up for other hosts.
 */

let started: Promise<number> | null = null;
let server: Server | null = null;
const KEY = randomBytes(32);

/** Hosts a tunnel may reach: exact names, or `*.suffix` for any name under it. */
export type EgressHosts = readonly string[];

function sign(user: string): string {
  return createHmac("sha256", KEY).update(user).digest("base64url");
}

/** Whether `host` is one of `allowed`. */
export function hostAllowed(host: string, allowed: EgressHosts): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
    return name === pattern;
  });
}

/** The hosts a proxy URL's credentials allow, or null for credentials this
 *  process didn't sign. */
export function egressHostsOf(proxyAuthorization: string | undefined): EgressHosts | null {
  const match = /^Basic\s+(.+)$/i.exec(proxyAuthorization ?? "");
  if (!match) return null;
  const [user = "", password = ""] = Buffer.from(match[1]!, "base64").toString("utf8").split(":");
  const expected = Buffer.from(sign(user));
  const given = Buffer.from(password);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const hosts = JSON.parse(Buffer.from(user, "base64url").toString("utf8")) as unknown;
    return Array.isArray(hosts) && hosts.every((h) => typeof h === "string") ? hosts : null;
  } catch {
    return null;
  }
}

/** Answer a CONNECT: a tunnel to an allowed host, public-only; anything else
 *  refused. `lookup` is a test seam. Exported for tests. */
export function handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer, lookup: LookupFunction = publicOnlyLookup): void {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const allowed = egressHostsOf(req.headers["proxy-authorization"]);
  if (!allowed) return void refuse("407 Proxy Authentication Required");
  let target: URL;
  try {
    target = new URL(`http://${req.url ?? ""}`);
  } catch {
    return void refuse("400 Bad Request");
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || 443);
  if (!hostAllowed(host, allowed) || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return void refuse("403 Forbidden");
  }
  const upstream = connect({ host, port, lookup });
  let opened = false;
  upstream.once("connect", () => {
    opened = true;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.once("error", () => {
    if (!opened) refuse("502 Bad Gateway");
    else socket.destroy();
  });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}

function listen(): Promise<number> {
  started ??= new Promise<number>((resolve, reject) => {
    const s = createServer((_req, res) => res.writeHead(405, { connection: "close" }).end());
    s.on("connect", (req, socket, head) => handleConnect(req, socket, head));
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      server = s;
      s.unref();
      resolve((s.address() as { port: number }).port);
    });
  }).catch((error: unknown) => {
    started = null;
    throw error;
  });
  return started;
}

/** A proxy URL for the SDK that reaches only `hosts`. */
export async function egressProxyFor(hosts: EgressHosts): Promise<string> {
  const port = await listen();
  const user = Buffer.from(JSON.stringify([...hosts].sort())).toString("base64url");
  return `http://${user}:${sign(user)}@127.0.0.1:${port}`;
}

/** The hosts a self-hosted E2B is reached at: its API, and its client-proxy
 *  (or E2B's cloud domain for boxes, when it names none). */
export function selfHostedE2bHosts(target: { apiUrl?: string; sandboxUrl?: string }, cloudDomain: string): EgressHosts {
  const hosts = new Set<string>();
  if (target.apiUrl) hosts.add(new URL(target.apiUrl).hostname.toLowerCase());
  if (target.sandboxUrl) hosts.add(new URL(target.sandboxUrl).hostname.toLowerCase());
  else hosts.add(`*.${cloudDomain}`);
  return [...hosts];
}

/** Stop the proxy, and the fetches pointed at it: a test seam. */
export function stopE2bEgress(): void {
  void import("@/lib/runtime/sandbox/e2b-sdk").then(({ closeProxiedFetches }) => closeProxiedFetches());
  server?.close();
  server = null;
  started = null;
}
