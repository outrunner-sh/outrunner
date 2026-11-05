import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import type { PreviewDomain } from "@/lib/previews/host";
import {
  createPreviewProxy,
  forwardHeaders,
  privateCaching,
  readCookie,
  rewriteLocation,
  rewriteSetCookie,
  stripCookie,
} from "@/lib/previews/proxy";
import { edgeHostSignature, edgeHostSigned } from "@/lib/previews/tokens";
import type { GateDecision, GateRequest } from "@/lib/previews/wire";

const DOMAIN: PreviewDomain = { host: "preview.test", secure: true };
const LOGIN = "abcdefghij0123456789";
const PUBLIC = "publicpreview0000001";
const ASLEEP = "asleeppreview0000001";
const COOKIE = "__Host-outrunner-preview";
const EDGE_KEY = "edge-credentials-key";
/** The headers the Cloudflare Worker sends naming `host`, signed. */
const fromWorker = (host: string) => ({ "x-outrunner-preview-host": host, "x-outrunner-preview-host-signature": edgeHostSignature(EDGE_KEY, host) });

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
  appHost: () => "app.test",
  edgeNamed: (host, signature) => edgeHostSigned(EDGE_KEY, host, signature),
  sessionValid: (_slug, session) => session === "member-session" || session === "owner-session",
  gate: async (req) => {
    asked.push(req);
    const through = (hostHeader: "preview" | "upstream"): GateDecision => ({
      kind: "proxy",
      upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, headers: { "x-daytona-preview-token": "box-credential" }, hostHeader },
      mode: hostHeader === "preview" ? "public" : "login",
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

test("a request for the app's host is left to Next, whatever it names", async () => {
  assert.equal((await call(null, "/")).body, "Next");
  const named = await call(null, "/", { headers: fromWorker(`${PUBLIC}.preview.test`) });
  assert.equal(named.body, "Next", "a preview's page is never served on the app's host");
});

test("straight to Node, a named host without the Worker's signature is ignored for the Host the request came to", async () => {
  // Asked of the public preview, naming the login one: it's the public one.
  const forgeries: Record<string, string>[] = [
    { "x-outrunner-preview-host": `${LOGIN}.preview.test` },
    { "x-outrunner-preview-host": `${LOGIN}.preview.test`, "x-outrunner-preview-host-signature": edgeHostSignature("not-the-key", `${LOGIN}.preview.test`) },
    { "x-outrunner-preview-host": `${LOGIN}.preview.test`, "x-outrunner-preview-host-signature": edgeHostSignature(EDGE_KEY, `${PUBLIC}.preview.test`) },
    // A junk name can't push a preview's own request through to Next.
    { "x-outrunner-preview-host": "junk", "x-outrunner-preview-host-signature": edgeHostSignature(EDGE_KEY, "junk") },
  ];
  for (const forged of forgeries) {
    const answer = await call(PUBLIC, "/", { headers: { ...forged, "cf-connecting-ip": "203.0.113.66" } });
    assert.equal(answer.status, 200, JSON.stringify(forged));
    const seen = JSON.parse(answer.body) as { headers: IncomingHttpHeaders };
    assert.equal(seen.headers.host, `${PUBLIC}.preview.test`, "the public preview, by its Host");
    // Nor is its CF-Connecting-IP believed: it didn't come through Cloudflare.
    assert.notEqual(seen.headers["x-real-ip"], "203.0.113.66");
    assert.equal(seen.headers["x-outrunner-preview-host"], undefined);
  }
  // And a forged name on another host is nobody's preview.
  const elsewhere = await call(null, "/", { headers: { host: "other.test", "x-outrunner-preview-host": `${PUBLIC}.preview.test` } });
  assert.equal(elsewhere.body, "Next");
});

test("a host under the preview domain that names no preview is never the app's", async () => {
  for (const label of ["www", "not-a-slug"]) {
    const answer = await call(label, "/");
    assert.equal(answer.status, 404, label);
    assert.match(answer.body, /No such preview/);
  }
});

test("a session cookie that isn't well signed is no session, and isn't asked about", async () => {
  asked.length = 0;
  await call(LOGIN, "/", { headers: { cookie: `${COOKIE}=junk-${Math.random()}` } });
  assert.deepEqual(asked, [{ op: "resolve", slug: LOGIN, session: null }]);
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
  // What a signed-in visitor sees stays out of shared caches.
  assert.equal(answer.headers["cache-control"], "private");
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

/** The status a WebSocket handshake to `slug`'s preview ends in: 0 when it
 * connects, the server's answer when it doesn't. */
function wsStatus(slug: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/_hmr`, { headers: { ...fromWorker(`${slug}.preview.test`), ...headers } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
    ws.on("open", () => {
      ws.close();
      resolve(0);
    });
  });
}

test("a request naming another host in its target is refused", async () => {
  assert.equal((await call(PUBLIC, "http://169.254.169.254/latest")).status, 400);
});

test("another page's request can't put a signed-in visitor's session to work on a login preview", async () => {
  // Another site's fetch: the visitor's SameSite=Lax cookie rides along, but
  // isn't let through.
  const cross = await call(LOGIN, "/api/data", {
    headers: { cookie: `${COOKIE}=member-session`, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
  });
  assert.equal(cross.status, 403);
  // Another preview's page: the same site (one preview domain), its own Origin.
  const neighbor = await call(LOGIN, "/api/data", {
    headers: { cookie: `${COOKIE}=member-session`, origin: `https://${PUBLIC}.preview.test`, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
  });
  assert.equal(neighbor.status, 403);
  // The preview's own page's fetch reaches the box, as does a plain client's
  // (a webhook's, a script's), which says nothing of where it's from.
  const own = await call(LOGIN, "/api/data", {
    headers: { cookie: `${COOKIE}=member-session`, origin: `https://${LOGIN}.preview.test`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
  });
  assert.equal(own.status, 200);
  const plain = await call(LOGIN, "/api/data", { headers: { cookie: `${COOKIE}=member-session` } });
  assert.equal(plain.status, 200);
});

test("a public preview answers anyone with the link, whatever origin they come from", async () => {
  // Its cookie unlocks nothing, so nothing is guarded: another preview's
  // page calling it (its own frontend, say), a form a provider posts to it.
  const fetched = await call(PUBLIC, "/api/data", {
    headers: { origin: `https://${LOGIN}.preview.test`, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
  });
  assert.equal(fetched.status, 200);
  const formPost = await call(PUBLIC, "/auth/apple/callback", {
    method: "POST",
    headers: { origin: "https://appleid.apple.com", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    body: "code=1",
  });
  assert.equal(formPost.status, 200, "an OAuth response_mode=form_post callback belongs on a public preview (docs/previews.md)");
  const seen = JSON.parse(formPost.body) as { method: string; body: string };
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, "code=1", "the posted body arrives");
  assert.equal(
    await wsStatus(PUBLIC, { origin: `https://${LOGIN}.preview.test`, "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket" }),
    0,
    "another preview's page's WebSocket (its frontend talking to it) connects",
  );
});

test("a cross-site form POST to a login preview is refused even as a navigation; the preview's own form posts work", async () => {
  // SameSite=Lax never sends the cookie on one, so it can't sign the
  // visitor in — such a callback belongs on a public preview — and the
  // fresh-set cookie a browser does send for its first minutes is the
  // cross-site POST the session must not be put to work on.
  const formPost = await call(LOGIN, "/auth/callback", {
    method: "POST",
    headers: { cookie: `${COOKIE}=member-session`, origin: "https://appleid.apple.com", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    body: "code=1",
  });
  assert.equal(formPost.status, 403);
  const own = await call(LOGIN, "/form", {
    method: "POST",
    headers: { cookie: `${COOKIE}=member-session`, origin: `https://${LOGIN}.preview.test`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
    body: "a=1",
  });
  assert.equal(own.status, 200);
  const seen = JSON.parse(own.body) as { body: string };
  assert.equal(seen.body, "a=1");
});

test("a browser that followed a link to a preview is let in, cross-site as the click may be", async () => {
  const answer = await call(LOGIN, "/dashboard", {
    headers: { cookie: `${COOKIE}=member-session`, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(answer.status, 200);
  // And a signed-out visitor still goes to sign in, not to a 403.
  const out = await call(LOGIN, "/dashboard", {
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(out.status, 302);
  assert.equal(out.headers.location, `https://app.test/previews/${LOGIN}?r=${encodeURIComponent("/dashboard")}`);
});

test("a WebSocket reaches the box (hot reload), as the Worker names the host", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/_hmr?token=1`, {
    headers: { ...fromWorker(`${LOGIN}.preview.test`), cookie: `${COOKIE}=member-session` },
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
  const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/_hmr`, { headers: fromWorker(`${LOGIN}.preview.test`) });
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
  });
  assert.equal(status, 401);
});

test("another page's WebSocket can't tunnel into a login preview; the preview's own connects", async () => {
  // Browsers always name their page's origin on a WebSocket: another
  // preview's, signed in as the visitor, is refused before the box is asked.
  assert.equal(
    await wsStatus(LOGIN, { cookie: `${COOKIE}=member-session`, origin: `https://${PUBLIC}.preview.test`, "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket" }),
    403,
  );
  assert.equal(
    await wsStatus(LOGIN, { cookie: `${COOKIE}=member-session`, origin: `https://evil.example`, "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket" }),
    403,
  );
  // The preview's own page's WebSocket (hot reload), and a plain client's,
  // connect as before.
  assert.equal(await wsStatus(LOGIN, { cookie: `${COOKIE}=member-session`, origin: `https://${LOGIN}.preview.test`, "sec-fetch-site": "same-origin" }), 0);
  assert.equal(await wsStatus(LOGIN, { cookie: `${COOKIE}=member-session` }), 0);
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
  assert.equal(privateCaching(undefined), "private");
  assert.equal(privateCaching("public, max-age=600, s-maxage=3600"), "private, max-age=600");
  assert.equal(privateCaching("no-store"), "no-store");

  const headers = forwardHeaders(
    {
      headers: { connection: "keep-alive, x-secret-hop", "x-secret-hop": "1", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9", te: "trailers" },
      socket: { remoteAddress: "10.0.0.1" } as never,
    },
    { ...at, edge: true },
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
  // Not through the Worker: the connection's address, not the header's.
  const direct = forwardHeaders(
    { headers: { "cf-connecting-ip": "203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } as never },
    at,
    { baseUrl: "https://3000-box.proxy.daytona.works", headers: {}, hostHeader: "upstream" },
    false,
  );
  assert.equal(direct["x-real-ip"], "10.0.0.1");
  assert.equal(direct["x-forwarded-for"], "10.0.0.1");
});

test("an answer is acted on for as long as the gate says, then asked again: how long a revoked link lasts", async () => {
  let clock = 1_000_000;
  let calls = 0;
  let open = true;
  const timed = createPreviewProxy({
    domain: () => DOMAIN,
    appHost: () => "app.test",
    edgeNamed: () => false,
    sessionValid: () => false,
    now: () => clock,
    gate: async () => {
      calls++;
      // Slow enough that a page's requests arrive while it's being asked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return open
        ? ({ kind: "proxy", upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, headers: {}, hostHeader: "preview" }, mode: "public", ttlMs: 10_000 } satisfies GateDecision)
        : ({ kind: "page", status: 404, page: "missing", ttlMs: 10_000 } satisfies GateDecision);
    },
  });
  const server = createServer((req, res) => {
    if (!timed.handle(req, res)) res.end("Next");
  });
  const port = await listen(server);
  const get = () =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: `${PUBLIC}.preview.test` } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });

  // A page and its assets at once: one question between them.
  assert.deepEqual(await Promise.all([get(), get(), get()]), [200, 200, 200]);
  assert.equal(calls, 1);

  // Deleted meanwhile: the answer already given holds until it runs out...
  open = false;
  clock += 9_000;
  assert.equal(await get(), 200);
  assert.equal(calls, 1);
  // ...and not a moment past it.
  clock += 1_001;
  assert.equal(await get(), 404);
  assert.equal(calls, 2);

  // Its link expired (the app's forgetPreviewDecisions): the next request
  // asks again at once, rather than use what was decided with that link.
  open = true;
  assert.equal(await get(), 404, "still the answer kept");
  timed.forget(PUBLIC);
  assert.equal(await get(), 200);
  assert.equal(calls, 3);
});
