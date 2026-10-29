/**
 * The web app's HTTP server: Next, plus the relay for Neev sessions' live
 * terminal and conversation (lib/runtime/sandbox/neev-relay.ts), which are
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
import { previewSigningKey, sessionUser } from "./lib/previews/tokens.ts";
import { GATE_PATH, GATE_SECRET_ENV, GATE_SECRET_HEADER } from "./lib/previews/wire.ts";
import { createNeevRelay } from "./lib/runtime/sandbox/neev-relay.ts";

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
const relay = createNeevRelay();
const previews = createPreviewProxy({
  domain: () => previewDomain(),
  appHost: () => (process.env.RUNTIME_BASE_URL ? new URL(process.env.RUNTIME_BASE_URL).host : null),
  sessionValid: (slug, session) => {
    const credentials = process.env.CREDENTIALS_ENCRYPTION_KEY;
    return !!credentials && sessionUser(previewSigningKey(credentials), session, slug) !== null;
  },
  gate: loopbackGate(port, gateSecret, GATE_SECRET_HEADER, GATE_PATH),
});
const previewsOff = previewDomainOf();
if (!previewsOff.ok) console.log(`> Previews are off: ${previewsOff.reason}`);

createServer((req, res) => {
  if (!previews.handle(req, res)) void handle(req, res);
})
  .on("upgrade", (req, socket, head) => {
    if (previews.upgrade(req, socket, head)) return;
    if (!relay(req, socket, head)) void upgradeNext(req, socket, head);
  })
  .listen(port, () => console.log(`> Ready on http://localhost:${port}`));
