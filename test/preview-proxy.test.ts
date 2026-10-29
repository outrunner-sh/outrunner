import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import type { PreviewDomain } from "@/lib/previews/host";
import { createPreviewProxy, forwardHeaders, readCookie, rewriteLocation, rewriteSetCookie, stripCookie } from "@/lib/previews/proxy";
import type { GateDecision, GateRequest } from "@/lib/previews/wire";

const DOMAIN: PreviewDomain = { host: "preview.test", secure: true };
const LOGIN = "abcdefghij0123456789";
const PUBLIC = "publicpreview0000001";
const ASLEEP = "asleeppreview0000001";
const COOKIE = "__Host-outrunner-preview";

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// --- A stand-in for the user's server on the box -----------------------------

const upstream = createServer((req, res) => {
  if (req.url?.startsWith("/redirect")) {
    res.writeHead(302, {
      location: `http://${req.headers.host}/after?x=1`,
      "set-cookie": ["app=1; Domain=127.0.0.1; Path=/; HttpOnly", `${COOKIE}=stolen; Path=/`],
    });
    return res.end();
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
});
const sockets = new WebSocketServer({ server: upstream });
sockets.on("connection", (ws, req) => {
  ws.send(JSON.stringify({ url: req.url, headers: req.headers }));
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
});
const upstreamPort = await listen(upstream);

// --- The proxy, with a stand-in for the app's gate ---------------------------

const asked: GateRequest[] = [];
const proxy = createPreviewProxy({
  domain: () => DOMAIN,
  gate: async (req) => {
    asked.push(req);
    const through = (hostHeader: "preview" | "upstream"): GateDecision => ({
      kind: "proxy",
      upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, headers: { "x-daytona-preview-token": "box-credential" }, hostHeader },
      ttlMs: 0,
    });
    if (req.op === "redeem") return req.ticket === "good-ticket" ? { ok: true, cookie: "member-session", maxAge: 600 } : { ok: false };
    if (req.op === "wake") return { ok: req.session === "owner-session" };
    if (req.slug === PUBLIC) return through("preview");
    if (req.slug === ASLEEP) return { kind: "page", status: 503, page: "asleep", canWake: req.session === "owner-session", ttlMs: 0 };
    if (req.session === "member-session" || req.session === "owner-session") return through("upstream");
    return { kind: "login", signInUrl: `https://app.test/previews/${req.slug}`, ttlMs: 0 };
  },
});
const front = createServer((req, res) => {
  if (!proxy.handle(req, res)) {
    res.writeHead(418);
    res.end("Next");
  }
}).on("upgrade", (req, socket, head) => {
  if (!proxy.upgrade(req, socket, head)) socket.destroy();
});
const frontPort = await listen(front);

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

function call(slug: string | null, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: frontPort,
        method: options.method ?? "GET",
        path,
        headers: { host: slug ? `${slug}.preview.test` : "app.test", ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

test("a request for any other host is left to Next", async () => {
  assert.equal((await call(null, "/")).body, "Next");
  assert.equal((await call("not-a-slug", "/")).body, "Next");
});

test("a signed-out visitor's page load goes to sign in, with the path to come back to; a script's fetch gets a 401", async () => {
  const page = await call(LOGIN, "/dashboard?tab=2", { headers: { "sec-fetch-mode": "navigate" } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, `https://app.test/previews/${LOGIN}?r=${encodeURIComponent("/dashboard?tab=2")}`);
  const fetched = await call(LOGIN, "/api/data", { headers: { "sec-fetch-mode": "cors" } });
  assert.equal(fetched.status, 401);
});

test("a ticket signs the visitor in with a cookie kept to the preview's host, once", async () => {
  const signedIn = await call(LOGIN, `/__outrunner/auth?ticket=good-ticket&r=${encodeURIComponent("/callback?code=1")}`);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, "/callback?code=1");
  const [cookie] = signedIn.headers["set-cookie"] ?? [];
  assert.match(cookie!, /^__Host-outrunner-preview=member-session; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);

  const refused = await call(LOGIN, "/__outrunner/auth?ticket=spent&r=//evil.com");
  assert.equal(refused.status, 401);
  assert.match(refused.body, /expired/);
  assert.equal(refused.headers["set-cookie"], undefined);
});

test("a signed-in visitor's request reaches the box as asked, without the preview's cookie, saying where it came to", async () => {
  const answer = await call(LOGIN, "/oauth/callback?code=abc&state=x%2Fy", {
    method: "POST",
    headers: {
      cookie: `theirs=1; ${COOKIE}=member-session; other=2`,
      "x-daytona-preview-token": "the visitor's own",
      "x-forwarded-host": "spoofed.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "a=1",
  });
  assert.equal(answer.status, 200);
  const seen = JSON.parse(answer.body) as { method: string; url: string; headers: IncomingHttpHeaders; body: string };
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/oauth/callback?code=abc&state=x%2Fy");
  assert.equal(seen.body, "a=1");
  assert.equal(seen.headers.cookie, "theirs=1; other=2");
  assert.equal(seen.headers["x-daytona-preview-token"], "box-credential");
  assert.equal(seen.headers["x-forwarded-host"], `${LOGIN}.preview.test`);
  assert.equal(seen.headers["x-forwarded-proto"], "https");
  assert.equal(seen.headers["x-forwarded-port"], "443");
  assert.match(String(seen.headers.forwarded), new RegExp(`host="${LOGIN}\\.preview\\.test";proto=https`));
  // Through a provider's proxy, the Host is the proxy's, which routes by it.
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`);
});

test("straight to the port, the box's server is told the preview's own host", async () => {
  const answer = await call(PUBLIC, "/");
  const seen = JSON.parse(answer.body) as { headers: IncomingHttpHeaders };
  assert.equal(seen.headers.host, `${PUBLIC}.preview.test`);
});

test("a redirect to the box's host comes back to the preview's, and its cookies stay on the preview's host", async () => {
  const answer = await call(PUBLIC, "/redirect");
  assert.equal(answer.status, 302);
  // The box saw the preview's host, so its absolute redirect already names it.
  assert.equal(answer.headers.location, `http://${PUBLIC}.preview.test/after?x=1`);
  assert.deepEqual(answer.headers["set-cookie"], ["app=1; Path=/; HttpOnly"]);
});

test("an asleep session's preview shows a page, with a wake button for its owner", async () => {
  const visitor = await call(ASLEEP, "/");
  assert.equal(visitor.status, 503);
  assert.match(visitor.body, /asleep/);
  assert.doesNotMatch(visitor.body, /Wake the session/);
  assert.equal(visitor.headers["cache-control"], "no-store");
  const owner = await call(ASLEEP, "/x", { headers: { cookie: `${COOKIE}=owner-session` } });
  assert.match(owner.body, /Wake the session/);
});

test("waking takes the preview's own page's form, never another site's", async () => {
  const cross = await call(ASLEEP, "/__outrunner/wake?r=/x", {
    method: "POST",
    headers: { cookie: `${COOKIE}=owner-session`, origin: "https://evil.example" },
  });
  assert.equal(cross.status, 403);
  const own = await call(ASLEEP, "/__outrunner/wake?r=/x", {
    method: "POST",
    headers: { cookie: `${COOKIE}=owner-session`, origin: `https://${ASLEEP}.preview.test` },
  });
  assert.equal(own.status, 202);
  assert.ok(asked.some((r) => r.op === "wake" && r.slug === ASLEEP && r.session === "owner-session"));
});

test("a request naming another host in its target is refused", async () => {
  assert.equal((await call(PUBLIC, "http://169.254.169.254/latest")).status, 400);
});

test("a WebSocket reaches the box (hot reload), as the Worker names the host", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/_hmr?token=1`, {
    headers: { "x-outrunner-preview-host": `${LOGIN}.preview.test`, cookie: `${COOKIE}=member-session` },
    perMessageDeflate: false,
  });
  const messages: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (data) => {
      messages.push(String(data));
      if (messages.length === 1) ws.send("ping");
      if (messages.length === 2) resolve();
    });
    ws.on("error", reject);
  });
  ws.close();
  const hello = JSON.parse(messages[0]!) as { url: string; headers: IncomingHttpHeaders };
  assert.equal(hello.url, "/_hmr?token=1");
  assert.equal(hello.headers.cookie, undefined);
  assert.equal(hello.headers["x-daytona-preview-token"], "box-credential");
  assert.equal(hello.headers["x-forwarded-host"], `${LOGIN}.preview.test`);
  assert.equal(messages[1], "ping");
});

test("a signed-out visitor's WebSocket is refused", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/_hmr`, { headers: { "x-outrunner-preview-host": `${LOGIN}.preview.test` } });
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
  });
  assert.equal(status, 401);
});

test("cookies and headers are read and rewritten exactly", () => {
  assert.equal(readCookie("a=1; __Host-outrunner-preview=s.t; b=2", COOKIE), "s.t");
  assert.equal(readCookie("x__Host-outrunner-preview=s", COOKIE), null);
  assert.equal(stripCookie(`${COOKIE}=s`, COOKIE), null);
  assert.equal(stripCookie(`a=1;${COOKIE}=s;b=2`, COOKIE), "a=1; b=2");
  const target = new URL("https://3000-box.proxy.daytona.works");
  const at = { domain: DOMAIN, host: `${LOGIN}.preview.test` };
  assert.equal(rewriteLocation("https://3000-box.proxy.daytona.works/a?b=1#c", at, target), `https://${LOGIN}.preview.test/a?b=1#c`);
  assert.equal(rewriteLocation("https://github.com/login/oauth/authorize?x=1", at, target), "https://github.com/login/oauth/authorize?x=1");
  assert.equal(rewriteLocation("/relative", at, target), "/relative");
  assert.equal(rewriteSetCookie("sid=1; Domain=.preview.test; Path=/", at), "sid=1; Path=/", "never to every preview");
  assert.equal(rewriteSetCookie(`${COOKIE}=x; Path=/`, at), null);

  const headers = forwardHeaders(
    {
      headers: { connection: "keep-alive, x-secret-hop", "x-secret-hop": "1", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9", te: "trailers" },
      socket: { remoteAddress: "10.0.0.1" } as never,
    },
    at,
    { baseUrl: "https://3000-box.proxy.daytona.works", headers: { "X-Daytona-Preview-Token": "t" }, hostHeader: "upstream" },
    false,
  );
  assert.equal(headers["x-secret-hop"], undefined);
  assert.equal(headers.te, undefined);
  assert.equal(headers["cf-connecting-ip"], undefined);
  assert.equal(headers["x-forwarded-for"], "203.0.113.9");
  assert.equal(headers["x-real-ip"], "203.0.113.9");
  assert.equal(headers.host, "3000-box.proxy.daytona.works");
  assert.equal(headers["x-daytona-preview-token"], "t");
});
