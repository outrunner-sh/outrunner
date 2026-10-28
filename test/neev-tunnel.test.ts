import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import ssh2 from "ssh2";
import WebSocket, { createWebSocketStream, WebSocketServer } from "ws";

import { closeNeevTunnels, neevTunnel } from "@/lib/runtime/sandbox/neev-tunnel";

/**
 * A stand-in for a Neev sandbox's runtime: SSH over a WebSocket at /v1/ssh,
 * authorized by the API key's bearer header (no SSH credential, like Neev),
 * forwarding each `direct-tcpip` channel to a port on this machine, where an
 * HTTP and WebSocket "agent" listens.
 */
const KEY = "sk-nc-tunnel-test";
let runtimeUrl = "";
let agentPort = 0;
let sshConnections = 0;
const servers: Server[] = [];
/** A host key ssh2 can read back: about 1 in 200 of the ed25519 keys its own
 *  generator makes it then refuses ("Malformed OpenSSH private key"), which
 *  failed this file now and then. */
function hostKey(): string {
  for (;;) {
    const key = ssh2.utils.generateKeyPairSync("ed25519").private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
}
const ssh = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
  sshConnections += 1;
  client.on("authentication", (ctx) => (ctx.method === "none" && ctx.username === "neev" ? ctx.accept() : ctx.reject()));
  client.on("tcpip", (accept, reject, info) => {
    const socket = connect(info.destPort, info.destIP, () => {
      const channel = accept();
      channel.pipe(socket).pipe(channel);
    });
    socket.once("error", () => reject());
  });
  client.on("error", () => {});
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

before(async () => {
  process.env.NEEV_API_KEY = KEY;

  const agent = createServer((req, res) => res.end(`agent saw ${req.method} ${req.url}`));
  const agentWss = new WebSocketServer({ server: agent });
  agentWss.on("connection", (ws) => ws.on("message", (data) => ws.send(`echo ${data}`)));
  agentPort = await listen(agent);

  const runtime = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  runtime.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/ssh" || req.headers.authorization !== `Bearer ${KEY}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => ssh.injectSocket(createWebSocketStream(ws) as never));
  });
  runtimeUrl = `http://127.0.0.1:${await listen(runtime)}/`;
});

after(() => {
  closeNeevTunnels("box-1");
  closeNeevTunnels("box-2");
  for (const server of servers) server.close();
  ssh.close();
});

test("a request through the tunnel reaches the port inside the sandbox", async () => {
  const base = await neevTunnel("box-1", agentPort, runtimeUrl);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const res = await fetch(`${base}/workspaces/w1/summary?x=1`);
  assert.equal(await res.text(), "agent saw GET /workspaces/w1/summary?x=1");
});

test("WebSockets go through it too, and one SSH connection carries them all", async () => {
  const base = await neevTunnel("box-1", agentPort, runtimeUrl);
  const before = sshConnections;
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/pty?token=t`);
  await new Promise((resolve) => ws.once("open", resolve));
  const reply = new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())));
  ws.send("ls");
  assert.equal(await reply, "echo ls");
  ws.close();
  await Promise.all([fetch(`${base}/a`), fetch(`${base}/b`)].map((r) => r.then((x) => x.text())));
  assert.equal(sshConnections, before, "reused the connection the first test opened");
});

test("the same sandbox port gets the same tunnel; another sandbox gets its own", async () => {
  const first = await neevTunnel("box-1", agentPort, runtimeUrl);
  assert.equal(await neevTunnel("box-1", agentPort), first);
  const other = await neevTunnel("box-2", agentPort, runtimeUrl);
  assert.notEqual(other, first);
  assert.equal(await (await fetch(`${other}/x`)).text(), "agent saw GET /x");
});

test("a closed tunnel stops answering, and the next use opens a new one", async () => {
  const old = await neevTunnel("box-2", agentPort, runtimeUrl);
  closeNeevTunnels("box-2");
  await assert.rejects(fetch(`${old}/x`));
  const fresh = await neevTunnel("box-2", agentPort, runtimeUrl);
  assert.notEqual(fresh, old);
  assert.equal(await (await fetch(`${fresh}/y`)).text(), "agent saw GET /y");
});
