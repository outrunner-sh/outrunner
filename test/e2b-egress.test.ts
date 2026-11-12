import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type LookupFunction } from "node:net";
import { after, test } from "node:test";

import { Sandbox } from "e2b";

import { egressHostsOf, egressProxyFor, handleConnect, hostAllowed, selfHostedE2bHosts, stopE2bEgress } from "@/lib/runtime/sandbox/e2b-egress";
import { e2bSdkOptions } from "@/lib/runtime/sandbox/e2b-sdk";

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  stopE2bEgress();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** The status line a CONNECT through `proxy` is answered with, and the
 *  tunnel's answer to a GET when it opens. */
function connectThrough(proxy: string, target: string): Promise<{ status: string; body: string }> {
  const url = new URL(proxy);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.startsWith("HTTP/1.1 200") && data.includes("\r\n\r\n") && !data.includes("tunnelled")) {
        socket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on("end", () => resolve({ status: data.split("\r\n")[0]!, body: data }));
    socket.on("error", reject);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  });
}

test("only the hosts a user named, or under a wildcard, are allowed", () => {
  const hosts = selfHostedE2bHosts({ apiUrl: "https://E2B-api.example.com", sandboxUrl: "https://e2b-sbx.example.com:8443" }, "e2b.app");
  assert.deepEqual(hosts, ["e2b-api.example.com", "e2b-sbx.example.com"]);
  assert.equal(hostAllowed("e2b-api.example.com", hosts), true);
  assert.equal(hostAllowed("E2B-API.example.com.", hosts), true);
  assert.equal(hostAllowed("evil.example.com", hosts), false);
  assert.equal(hostAllowed("169.254.169.254", hosts), false);
  const cloudBoxes = selfHostedE2bHosts({ apiUrl: "https://e2b-api.example.com" }, "e2b.app");
  assert.equal(hostAllowed("49983-sbx.e2b.app", cloudBoxes), true);
  assert.equal(hostAllowed("e2b.app", cloudBoxes), false);
  assert.equal(hostAllowed("e2b.app.evil.com", cloudBoxes), false);
});

test("a proxy URL's hosts can't be made up", async () => {
  const proxy = new URL(await egressProxyFor(["e2b-api.example.com"]));
  const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  assert.deepEqual(egressHostsOf(basic(proxy.username, proxy.password)), ["e2b-api.example.com"]);
  const forged = Buffer.from(JSON.stringify(["169.254.169.254"])).toString("base64url");
  assert.equal(egressHostsOf(basic(forged, proxy.password)), null);
  assert.equal(egressHostsOf(undefined), null);
});

test("the egress proxy refuses other hosts, and private addresses even for a named one", async () => {
  const target = await listen(createServer((_req, res) => res.end("tunnelled")));
  // Named, but it's loopback: refused as it connects, public-only.
  const proxy = await egressProxyFor(["localhost"]);
  assert.match((await connectThrough(proxy, `localhost:${target}`)).status, /502/);
  // Not named at all.
  assert.match((await connectThrough(proxy, `example.org:443`)).status, /403/);
});

test("a named host the lookup lets through is tunnelled", async () => {
  const target = await listen(createServer((_req, res) => res.end("tunnelled")));
  const loopback: LookupFunction = (_host, options, callback) =>
    options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }] as never) : callback(null, "127.0.0.1", 4);
  const port = await listen(createServer().on("connect", (req, socket, head) => handleConnect(req, socket, head, loopback)));
  const proxy = new URL(await egressProxyFor(["box.test"]));
  proxy.port = String(port);
  const answer = await connectThrough(proxy.toString(), `box.test:${target}`);
  assert.match(answer.status, /200/);
  assert.match(answer.body, /tunnelled/);
});

test("the E2B SDK sends its calls through the proxy it's given", async () => {
  const asked: string[] = [];
  const port = await listen(
    createServer().on("connect", (req, socket) => {
      asked.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }),
  );
  const options = e2bSdkOptions({ apiKey: "e2b_test", apiUrl: "https://e2b-api.example.com", proxy: `http://u:p@127.0.0.1:${port}` }, 5_000);
  await assert.rejects(Sandbox.list({ ...options, limit: 1 }).nextItems());
  assert.ok(asked.includes("e2b-api.example.com:443"), JSON.stringify(asked));
});

test("our own fetches to a user's E2B go through the egress proxy too", async () => {
  const { proxiedFetch } = await import("@/lib/runtime/sandbox/e2b-sdk");
  const target = await listen(createServer((_req, res) => res.end("reached")));
  // Named, but loopback: the proxy refuses it as it connects, so the fetch fails.
  const fetchVia = await proxiedFetch(await egressProxyFor(["localhost"]));
  await assert.rejects(fetchVia(`http://localhost:${target}/`));
  // And a host not named at all.
  await assert.rejects(fetchVia("https://example.org/"));
});
