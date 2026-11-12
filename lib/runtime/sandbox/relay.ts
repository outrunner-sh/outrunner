import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { openRelayTicket } from "./relay-ticket.ts";
import { neevTunnel } from "./neev-tunnel.ts";

/**
 * The browser's live terminal and conversation for a session on a provider
 * whose boxes the browser can't open a WebSocket to itself: Neev (whose
 * preview edge refuses the upgrade), a user's GCP (a private VM) and E2B
 * (whose proxy routes by headers a browser can't set). So the browser opens
 * them here, at `<prefix><sandbox>/<port>/<ticket>/<pty|events-ws>?token=…`,
 * and this server opens the same WebSocket to the agent on the way the
 * provider gives it ({@link RelayDeps.tunnel}) and passes frames both ways.
 * The Runtime token rides along untouched for the agent to check.
 *
 * One relay per provider, each on its own prefix and ticket key, all this
 * same code. Next's route handlers can't take a WebSocket, so the custom
 * server (server.ts) hands every upgrade to them first.
 */

/** Agent WebSockets the browser may reach. */
const RELAYED = new Set(["pty", "events-ws"]);
/** Keeps an idle terminal's connection open through proxies on both legs:
 *  in front of us (Cloudflare), and between us and the box. */
export const PING_MS = 25_000;

/** Where the relay opens the agent's WebSocket: a base URL and any headers
 *  the provider's way in needs (E2B's routing headers), never a browser's. */
export type RelayUpstream = { base: string; headers: Record<string, string> };

export type RelayDeps = {
  /** The key this provider's tickets are signed with; unset when it isn't
   *  configured, and every upgrade is refused. */
  key: () => string | undefined;
  /** The way to `port` in the sandbox; `secret` is what the ticket carried
   *  sealed for the relay (E2B's traffic token), if anything. */
  tunnel: (sandboxId: string, port: number, secret?: string) => Promise<RelayUpstream>;
};

/** Neev's: tickets under the project's Neev API key, through the sandbox's
 *  local tunnel. */
export const neevRelayDeps: RelayDeps = {
  key: () => process.env.NEEV_API_KEY,
  tunnel: async (sandboxId, port) => ({ base: await neevTunnel(sandboxId, port), headers: {} }),
};

/** An upgrade handler that takes the relay's own upgrades and returns false
 *  for anything else (such as Next's HMR). */
export function createSandboxRelay(deps: RelayDeps, prefix: string) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  function relay(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://relay");
    if (!url.pathname.startsWith(prefix)) return false;

    const [sandboxId = "", portText = "", ticket = "", target = "", ...rest] = url.pathname
      .slice(prefix.length)
      .split("/");
    const port = Number(portText);
    const key = deps.key();
    if (!key) return refuse(socket, 503);
    if (rest.length > 0 || !RELAYED.has(target) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return refuse(socket, 404);
    }
    const opened = openRelayTicket(ticket, sandboxId, port, key);
    if (!opened) return refuse(socket, 403);

    void connect(deps, wss, { req, socket, head, sandboxId, port, secret: opened.secret, path: `/${target}${url.search}` });
    return true;
  }

  /** Closes every relayed connection with `code` (server.ts, on SIGTERM:
   *  1012, "service restart"; the browser reconnects on any close) and
   *  answers how many there were. Each one's agent side is closed with it. */
  relay.closeAll = (code: number, reason: string): number => {
    const open = [...wss.clients];
    for (const client of open) closeWith(client, code, Buffer.from(reason));
    return open.length;
  };
  return relay;
}

/** "Service restart": the server is going away and a new one takes over;
 *  reconnect. */
export const SERVICE_RESTART = 1012;

async function connect(
  deps: RelayDeps,
  wss: WebSocketServer,
  c: { req: IncomingMessage; socket: Duplex; head: Buffer; sandboxId: string; port: number; secret?: string; path: string },
): Promise<void> {
  let upstreamAt: RelayUpstream;
  try {
    upstreamAt = await deps.tunnel(c.sandboxId, c.port, c.secret);
  } catch (error) {
    console.error(`Relay: no way into sandbox ${c.sandboxId}`, error);
    refuse(c.socket, 502);
    return;
  }
  if (c.socket.destroyed) return;

  const upstream = new WebSocket(`${upstreamAt.base.replace(/^http/, "ws")}${c.path}`, {
    perMessageDeflate: false,
    headers: upstreamAt.headers,
  });
  let settled = false;
  // The browser gave up while the agent was still answering.
  const abandon = () => {
    if (!settled) upstream.terminate();
  };
  c.socket.once("close", abandon);

  // The agent refused (a bad or expired Runtime token): the browser gets the
  // same status, as it would talking to the agent directly.
  upstream.once("unexpected-response", (_request, response) => {
    settled = true;
    refuse(c.socket, response.statusCode ?? 502);
    upstream.terminate();
  });
  upstream.once("error", (error) => {
    if (settled) return;
    settled = true;
    console.error(`Relay: agent WebSocket in sandbox ${c.sandboxId} failed`, error);
    refuse(c.socket, 502);
  });
  upstream.once("open", () => {
    settled = true;
    c.socket.off("close", abandon);
    wss.handleUpgrade(c.req, c.socket, c.head, (client) => bridge(client, upstream));
  });
}

/** Pass frames both ways, as text or binary as they came, and a close on.
 *  Both legs are pinged, so neither idles out behind a proxy. Exported for
 *  tests. */
export function bridge(client: WebSocket, upstream: WebSocket, pingMs = PING_MS): void {
  const send = (to: WebSocket) => (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
  };
  client.on("message", send(upstream));
  upstream.on("message", send(client));

  const ping = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping();
    if (upstream.readyState === WebSocket.OPEN) upstream.ping();
  }, pingMs);
  ping.unref();
  client.on("close", (code, reason) => {
    clearInterval(ping);
    closeWith(upstream, code, reason);
  });
  upstream.on("close", (code, reason) => {
    clearInterval(ping);
    closeWith(client, code, reason);
  });
  client.on("error", () => upstream.terminate());
  upstream.on("error", () => client.terminate());
}

function closeWith(ws: WebSocket, code: number, reason: Buffer): void {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  ws.close(sendable(code), reason);
}

/** A close code that can go in a close frame. "No status" becomes a normal
 *  close; a dropped connection, an error, so the other side reconnects. */
export function sendable(code: number): number {
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return code === 1005 ? 1000 : 1011;
}

/** Answer an upgrade with a plain HTTP status and hang up. */
function refuse(socket: Duplex, status: number): true {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  return true;
}
