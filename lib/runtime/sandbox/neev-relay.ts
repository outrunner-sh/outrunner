import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { NEEV_RELAY_PREFIX, relayTicketValid } from "./neev-relay-ticket.ts";
import { neevTunnel } from "./neev-tunnel.ts";

/**
 * The browser's live terminal and conversation for a Neev session. They are
 * WebSockets to the agent in the sandbox, which the browser can't open itself:
 * the only other way in is a preview URL, which Neev asks us not to use (and
 * whose edge refuses the upgrade). So the browser opens them here, at
 * `/relay/neev/<sandbox>/<port>/<ticket>/<pty|events-ws>?token=…`, and this
 * server opens the same WebSocket to the agent through the sandbox's runtime
 * (neev-tunnel.ts) and passes frames both ways. The Runtime token rides along
 * untouched for the agent to check.
 *
 * Next's route handlers can't take a WebSocket, so the custom server
 * (server.ts) hands every upgrade here first.
 */

/** Agent WebSockets the browser may reach. */
const RELAYED = new Set(["pty", "events-ws"]);
/** Keeps an idle terminal's connection open through proxies in front of us. */
const PING_MS = 25_000;

export type NeevRelayDeps = {
  /** The key tickets are signed with: the project's Neev API key. */
  key: () => string | undefined;
  /** The local base URL reaching `port` in the sandbox. */
  tunnel: (sandboxId: string, port: number) => Promise<string>;
};

const defaultDeps: NeevRelayDeps = {
  key: () => process.env.NEEV_API_KEY,
  tunnel: (sandboxId, port) => neevTunnel(sandboxId, port),
};

/** An upgrade handler that takes the relay's own upgrades and returns false
 *  for anything else (such as Next's HMR). */
export function createNeevRelay(deps: NeevRelayDeps = defaultDeps, prefix = NEEV_RELAY_PREFIX) {
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
    if (!relayTicketValid(ticket, sandboxId, port, key)) return refuse(socket, 403);

    void connect(deps, wss, { req, socket, head, sandboxId, port, path: `/${target}${url.search}` });
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
  deps: NeevRelayDeps,
  wss: WebSocketServer,
  c: { req: IncomingMessage; socket: Duplex; head: Buffer; sandboxId: string; port: number; path: string },
): Promise<void> {
  let base: string;
  try {
    base = await deps.tunnel(c.sandboxId, c.port);
  } catch (error) {
    console.error(`Neev relay: no way into sandbox ${c.sandboxId}`, error);
    refuse(c.socket, 502);
    return;
  }
  if (c.socket.destroyed) return;

  const upstream = new WebSocket(`${base.replace(/^http/, "ws")}${c.path}`, { perMessageDeflate: false });
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
    console.error(`Neev relay: agent WebSocket in sandbox ${c.sandboxId} failed`, error);
    refuse(c.socket, 502);
  });
  upstream.once("open", () => {
    settled = true;
    c.socket.off("close", abandon);
    wss.handleUpgrade(c.req, c.socket, c.head, (client) => bridge(client, upstream));
  });
}

/** Pass frames both ways, as text or binary as they came, and a close on. */
function bridge(client: WebSocket, upstream: WebSocket): void {
  const send = (to: WebSocket) => (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
  };
  client.on("message", send(upstream));
  upstream.on("message", send(client));

  const ping = setInterval(() => client.ping(), PING_MS);
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
