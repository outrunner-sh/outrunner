import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { EventEmitter } from "node:events";

import { bridge, createSandboxRelay, sendable, type RelayUpstream } from "@/lib/runtime/sandbox/relay";
import {
  mintRelayTicket,
  NEEV_RELAY_PREFIX,
  openRelayTicket,
  RELAY_TICKET_TTL_SECONDS,
  relayTicketValid,
} from "@/lib/runtime/sandbox/relay-ticket";

const KEY = "sk-nc-test-key";
const SANDBOX = "01a133a1-9738-7b65-89eb-96c1c2e9798b";

test("a ticket opens only its own sandbox port, until it expires", () => {
  const now = Date.UTC(2026, 9, 13, 8, 0, 0);
  const ticket = mintRelayTicket(SANDBOX, 8080, KEY, now);
  assert.equal(relayTicketValid(ticket, SANDBOX, 8080, KEY, now), true);
  assert.equal(relayTicketValid(ticket, "another-sandbox", 8080, KEY, now), false);
  assert.equal(relayTicketValid(ticket, SANDBOX, 8081, KEY, now), false);
  assert.equal(relayTicketValid(ticket, SANDBOX, 8080, "another-key", now), false);
  const later = now + (RELAY_TICKET_TTL_SECONDS + 1) * 1000;
  assert.equal(relayTicketValid(ticket, SANDBOX, 8080, KEY, later), false);
});

test("a tampered or malformed ticket opens nothing", () => {
  const ticket = mintRelayTicket(SANDBOX, 8080, KEY);
  const [exp, sig] = ticket.split(".");
  assert.equal(relayTicketValid(`${Number(exp) + 3600}.${sig}`, SANDBOX, 8080, KEY), false);
  assert.equal(relayTicketValid(`${exp}.${sig.slice(1)}`, SANDBOX, 8080, KEY), false);
  for (const bad of ["", ".", exp, `${exp}.`, `${ticket}.x`, `soon.${sig}`]) {
    assert.equal(relayTicketValid(bad, SANDBOX, 8080, KEY), false, bad);
  }
});

test("a ticket can carry a secret for the relay, sealed and signed", () => {
  const now = Date.UTC(2026, 9, 13, 8, 0, 0);
  const ticket = mintRelayTicket(SANDBOX, 8080, KEY, now, "traffic-token");
  assert.ok(!ticket.includes("traffic-token"));
  assert.deepEqual(openRelayTicket(ticket, SANDBOX, 8080, KEY, now), { secret: "traffic-token" });
  assert.equal(relayTicketValid(ticket, SANDBOX, 8080, KEY, now), true);
  assert.equal(openRelayTicket(ticket, "another-sandbox", 8080, KEY, now), null);
  assert.equal(openRelayTicket(ticket, SANDBOX, 8080, "another-key", now), null);
  const [exp, sig, sealed] = ticket.split(".");
  // Another sealed secret under the same signature, or none at all, opens nothing.
  const other = mintRelayTicket(SANDBOX, 8080, KEY, now, "someone-else").split(".")[2];
  assert.equal(openRelayTicket(`${exp}.${sig}.${other}`, SANDBOX, 8080, KEY, now), null);
  assert.equal(openRelayTicket(`${exp}.${sig}`, SANDBOX, 8080, KEY, now), null);
  assert.equal(openRelayTicket(`${exp}.${sig}.`, SANDBOX, 8080, KEY, now), null);
  assert.equal(openRelayTicket(`${exp}.${sig}.${sealed}x`, SANDBOX, 8080, KEY, now), null);
  // A plain ticket carries nothing.
  assert.deepEqual(openRelayTicket(mintRelayTicket(SANDBOX, 8080, KEY, now), SANDBOX, 8080, KEY, now), {});
});

test("the bridge pings both legs, so neither idles out behind a proxy", async () => {
  class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    pings = 0;
    ping() {
      this.pings += 1;
    }
    send() {}
    close() {}
    terminate() {}
  }
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  bridge(client as unknown as WebSocket, upstream as unknown as WebSocket, 10);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(client.pings >= 2, `browser pinged ${client.pings} times`);
  assert.ok(upstream.pings >= 2, `upstream pinged ${upstream.pings} times`);
  upstream.emit("close", 1000, Buffer.alloc(0));
  const after = upstream.pings;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(upstream.pings, after, "stops once a leg closes");
});

test("close codes that can't go in a close frame become ones that can", () => {
  assert.equal(sendable(1000), 1000);
  assert.equal(sendable(4001), 4001);
  assert.equal(sendable(1005), 1000);
  assert.equal(sendable(1006), 1011);
  assert.equal(sendable(1015), 1011);
});

// --- The relay, against a stand-in agent ------------------------------------

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** An agent that echoes each frame back, tagged with its path and query, and
 *  refuses a token of "bad". */
async function fakeAgent(): Promise<string> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.includes("token=bad")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(`hello ${req.url}`);
      ws.on("message", (data, isBinary) => {
        if (!isBinary && data.toString() === "bye") ws.close(4002, "done");
        else ws.send(data, { binary: isBinary });
      });
    });
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

async function relayServer(tunnel: (sandboxId: string, port: number, secret?: string) => Promise<RelayUpstream>): Promise<number> {
  const relay = createSandboxRelay({ key: () => KEY, tunnel }, NEEV_RELAY_PREFIX);
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    if (!relay(req, socket, head)) socket.end("HTTP/1.1 418 Not Relayed\r\n\r\n");
  });
  return listen(server);
}

function relayUrl(port: number, target: string, ticket = mintRelayTicket(SANDBOX, 8080, KEY)): string {
  return `ws://127.0.0.1:${port}${NEEV_RELAY_PREFIX}${SANDBOX}/8080/${ticket}/${target}`;
}

/** The status an upgrade was answered with. */
function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => reject(new Error("upgrade was accepted")));
    ws.once("error", () => {});
  });
}

function nextMessage(ws: WebSocket): Promise<{ data: string; isBinary: boolean }> {
  return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data: data.toString(), isBinary })));
}

test("the relay hands its tunnel the secret sealed in the ticket", async () => {
  const agent = await fakeAgent();
  const secrets: Array<string | undefined> = [];
  const port = await relayServer(async (_sandboxId, _port, secret) => {
    secrets.push(secret);
    return { base: agent, headers: {} };
  });
  for (const ticket of [mintRelayTicket(SANDBOX, 8080, KEY, Date.now(), "tat-1"), mintRelayTicket(SANDBOX, 8080, KEY)]) {
    const ws = new WebSocket(relayUrl(port, "pty", ticket));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.close();
  }
  assert.deepEqual(secrets, ["tat-1", undefined]);
});

test("the relay passes frames both ways, the token through, and the agent's close back", async () => {
  const agent = await fakeAgent();
  const asked: Array<[string, number]> = [];
  const port = await relayServer(async (sandboxId, sandboxPort) => {
    asked.push([sandboxId, sandboxPort]);
    return { base: agent, headers: {} };
  });

  const ws = new WebSocket(`${relayUrl(port, "events-ws")}?token=t0k&lastEventId=42`);
  const hello = nextMessage(ws);
  await new Promise((resolve) => ws.once("open", resolve));
  assert.equal((await hello).data, "hello /events-ws?token=t0k&lastEventId=42");
  assert.deepEqual(asked, [[SANDBOX, 8080]]);

  ws.send("typed");
  assert.deepEqual(await nextMessage(ws), { data: "typed", isBinary: false });
  ws.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await nextMessage(ws), { data: "\u0001\u0002\u0003", isBinary: true });

  const closed = new Promise<[number, string]>((resolve) =>
    ws.once("close", (code, reason) => resolve([code, reason.toString()])),
  );
  ws.send("bye");
  assert.deepEqual(await closed, [4002, "done"]);
});

test("the relay refuses a bad ticket, an unknown path, and passes the agent's refusal on", async () => {
  const agent = await fakeAgent();
  let tunnels = 0;
  const port = await relayServer(async () => {
    tunnels += 1;
    return { base: agent, headers: {} };
  });

  const expired = mintRelayTicket(SANDBOX, 8080, KEY, Date.now() - 2 * RELAY_TICKET_TTL_SECONDS * 1000);
  assert.equal(await upgradeStatus(relayUrl(port, "pty", expired)), 403);
  assert.equal(await upgradeStatus(relayUrl(port, "pty", mintRelayTicket(SANDBOX, 8080, "other-key"))), 403);
  assert.equal(await upgradeStatus(relayUrl(port, "workspaces")), 404);
  assert.equal(await upgradeStatus(`${relayUrl(port, "pty")}/more`), 404);
  // Nothing opened a way into the sandbox for those.
  assert.equal(tunnels, 0);

  assert.equal(await upgradeStatus(`${relayUrl(port, "pty")}?token=bad`), 401);
  assert.equal(tunnels, 1);
});

test("the relay leaves other upgrades to the server, and answers 502 when there is no way in", async () => {
  const port = await relayServer(async () => {
    throw new Error("sandbox gone");
  });
  assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/_next/webpack-hmr`), 418);
  const logged = console.error;
  console.error = () => {};
  try {
    assert.equal(await upgradeStatus(relayUrl(port, "pty")), 502);
  } finally {
    console.error = logged;
  }
});

test("a plain request to the relay prefix is not an upgrade the relay sees", async () => {
  const port = await relayServer(async () => ({ base: "http://127.0.0.1:1", headers: {} }));
  const status = await new Promise<number>((resolve) => {
    request(`http://127.0.0.1:${port}${NEEV_RELAY_PREFIX}x`, (res) => resolve(res.statusCode ?? 0)).end();
  });
  assert.equal(status, 404);
});

test("the relay sends the provider's routing headers upstream, and a browser can't set its own", async () => {
  // E2B's proxy routes by headers naming the sandbox and port: the relay's,
  // never ones a browser sent, which would otherwise pick another box.
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(`${req.headers["e2b-sandbox-id"]} ${req.headers["e2b-sandbox-port"]}`));
  });
  const agent = `http://127.0.0.1:${await listen(server)}`;
  const port = await relayServer(async (sandboxId, sandboxPort) => ({
    base: agent,
    headers: { "E2b-Sandbox-Id": sandboxId, "E2b-Sandbox-Port": String(sandboxPort) },
  }));

  const ws = new WebSocket(relayUrl(port, "pty"), { headers: { "E2b-Sandbox-Id": "someone-elses", "E2b-Sandbox-Port": "22" } });
  assert.equal((await nextMessage(ws)).data, `${SANDBOX} 8080`);
  ws.close();
});
