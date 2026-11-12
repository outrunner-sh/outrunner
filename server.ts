/**
 * The web app's HTTP server: Next, plus the relay for Neev sessions' live
 * terminal and conversation (lib/runtime/sandbox/relay.ts), which are
 * WebSockets and so can't be route handlers, and previews
 * (lib/previews/proxy.ts): any request, upgrade or not, to a preview's host
 * is the box's, never Next's. Every other upgrade (Next's HMR) goes to Next.
 * `pnpm dev` and `pnpm start` run it; Node strips the types.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import next from "next";

import { billingMode } from "./lib/billing/mode.ts";
import { previewDomain, previewDomainOf } from "./lib/previews/host.ts";
import { createPreviewProxy, loopbackGate } from "./lib/previews/proxy.ts";
import { onForgetPreview } from "./lib/previews/forget.ts";
import { edgeHostSigned, previewSigningKey, sessionUser } from "./lib/previews/tokens.ts";
import { GATE_PATH, GATE_SECRET_ENV, GATE_SECRET_HEADER } from "./lib/previews/wire.ts";
import { createSandboxRelay, neevRelayDeps } from "./lib/runtime/sandbox/relay.ts";
import { E2B_RELAY_PREFIX, NEEV_RELAY_PREFIX, relayKey, USER_E2B_RELAY_PREFIX } from "./lib/runtime/sandbox/relay-ticket.ts";
import { e2bRoute } from "./lib/runtime/sandbox/e2b-route.ts";
import { publicOnlyLookup } from "./lib/api/webhook-lookup.ts";
import { GCP_RELAY_PREFIX, gcpRelayKey } from "./lib/runtime/gcp/relay-ticket.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

// The preview proxy's proof to the app's gate (app/api/previews/gate), made
// fresh each start and set before Next loads, so its route handlers, in
// this process, read the same one.
const gateSecret = randomBytes(32).toString("base64url");
process.env[GATE_SECRET_ENV] = gateSecret;

const app = next({ dev, port });
const handle = app.getRequestHandler();
await app.prepare();
// Refuse to start on a billing setting that would decide wrongly what users
// get (lib/billing/mode.ts), rather than serve them on it. After prepare(),
// which loads .env files, so a setting made there counts.
billingMode();
const upgradeNext = app.getUpgradeHandler();
const neevRelay = createSandboxRelay(neevRelayDeps, NEEV_RELAY_PREFIX);
const gcpRelay = createSandboxRelay({
  key: () => process.env.CREDENTIALS_ENCRYPTION_KEY ? gcpRelayKey(process.env.CREDENTIALS_ENCRYPTION_KEY) : undefined,
  tunnel: async (id, agentPort) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime/gcp-relay`, {
      method: "POST", headers: { "content-type": "application/json", [GATE_SECRET_HEADER]: gateSecret },
      body: JSON.stringify({ id, port: agentPort }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("GCP relay could not reach its sandbox.");
    const result = await response.json() as { url: string };
    const url = new URL(result.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid GCP relay target.");
    return { base: url.origin, headers: {} };
  },
}, GCP_RELAY_PREFIX);
// E2B's proxy routes by headers, which the relay sets on its own connection.
const e2bRelay = createSandboxRelay({
  key: () => process.env.CREDENTIALS_ENCRYPTION_KEY ? relayKey(process.env.CREDENTIALS_ENCRYPTION_KEY, "e2b") : undefined,
  tunnel: async (id, agentPort) => e2bRoute(id, agentPort),
}, E2B_RELAY_PREFIX);
// A user's self-hosted E2B: the app looks up where their client-proxy is,
// from the box's owner, never the request.
const userE2bRelay = createSandboxRelay({
  key: () => process.env.CREDENTIALS_ENCRYPTION_KEY ? relayKey(process.env.CREDENTIALS_ENCRYPTION_KEY, "user-e2b") : undefined,
  tunnel: async (id, agentPort) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime/e2b-relay`, {
      method: "POST", headers: { "content-type": "application/json", [GATE_SECRET_HEADER]: gateSecret },
      body: JSON.stringify({ id, port: agentPort }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("The E2B relay could not reach its sandbox.");
    const route = await response.json() as { base: string; headers: Record<string, string> };
    if (new URL(route.base).protocol !== "https:") throw new Error("Invalid E2B relay target.");
    // The user named this host: its connection resolves it public-only.
    return { ...route, lookup: publicOnlyLookup };
  },
}, USER_E2B_RELAY_PREFIX);
const relays = [neevRelay, gcpRelay, e2bRelay, userE2bRelay];
const previews = createPreviewProxy({
  domain: () => previewDomain(),
  appHost: () => (process.env.RUNTIME_BASE_URL ? new URL(process.env.RUNTIME_BASE_URL).host : null),
  edgeNamed: (host, signature) => {
    const credentials = process.env.CREDENTIALS_ENCRYPTION_KEY;
    return !!credentials && edgeHostSigned(credentials, host, signature);
  },
  sessionValid: (slug, session) => {
    const credentials = process.env.CREDENTIALS_ENCRYPTION_KEY;
    return !!credentials && sessionUser(previewSigningKey(credentials), session, slug) !== null;
  },
  gate: loopbackGate(port, gateSecret, GATE_SECRET_HEADER, GATE_PATH),
});
// The app forgets a preview's answers here when its link is expired.
onForgetPreview(previews.forget);
const previewsOff = previewDomainOf();
if (!previewsOff.ok) console.log(`> Previews are off: ${previewsOff.reason}`);

createServer((req, res) => {
  if (!previews.handle(req, res)) void handle(req, res);
})
  .on("upgrade", (req, socket, head) => {
    if (previews.upgrade(req, socket, head)) return;
    if (!relays.some((relay) => relay(req, socket, head))) void upgradeNext(req, socket, head);
  })
  .listen(port, () => console.log(`> Ready on http://localhost:${port}`));
