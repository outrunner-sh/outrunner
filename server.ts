/**
 * The web app's HTTP server: Next, plus the relay for Neev sessions' live
 * terminal and conversation (lib/runtime/sandbox/neev-relay.ts), which are
 * WebSockets and so can't be route handlers, and previews
 * (lib/previews/proxy.ts): any request, upgrade or not, to a preview's host
 * is the box's, never Next's. Every other upgrade (Next's HMR) goes to Next.
 * `pnpm dev` and `pnpm start` run it; Node strips the types.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import next from "next";

import { billingMode } from "./lib/billing/mode.ts";
import { drained, holdOpen, pendingWork, startDraining } from "./lib/observability/drain.ts";
import { flushReports, reportError } from "./lib/observability/report.ts";
import { watchEventStream } from "./lib/observability/streams.ts";
import { checkStartupEnv } from "./lib/startup-env.ts";
import { previewDomain, previewDomainOf } from "./lib/previews/host.ts";
import { createPreviewProxy, loopbackGate } from "./lib/previews/proxy.ts";
import { onForgetPreview } from "./lib/previews/forget.ts";
import { edgeHostSigned, previewSigningKey, sessionUser } from "./lib/previews/tokens.ts";
import { GATE_PATH, GATE_SECRET_ENV, GATE_SECRET_HEADER } from "./lib/previews/wire.ts";
import { createNeevRelay, SERVICE_RESTART } from "./lib/runtime/sandbox/neev-relay.ts";
import { GCP_RELAY_PREFIX, gcpRelayKey } from "./lib/runtime/gcp/relay-ticket.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

/** How long a shutdown waits for requests and after() work under way. The
 *  Worker waits a little longer before it kills the container
 *  (cloudflare/worker.ts DRAIN_TIMEOUT_MS). */
const DRAIN_MS = dev ? 3_000 : 30_000;

/** The server, once it's listening: before then a shutdown has nothing to drain. */
let server: Server | null = null;

// Logged and reported, never silent. A rejection nothing handled is one
// piece of work's failure: the server goes on. An uncaught exception may
// have left anything half done, so the server drains and exits, as Node
// would have (without the drain), and the Worker starts a new one.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
  reportError(reason, { where: "unhandledRejection" });
});
process.on("uncaughtException", (error, origin) => {
  console.error(`Uncaught exception (${origin})`, error);
  reportError(error, { where: "uncaughtException" });
  void shutdown("uncaughtException", 1);
});

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
// And on one missing what every request needs (lib/startup-env.ts): the
// whole list, at once, rather than a 500 on the first request to need it.
checkStartupEnv();
const upgradeNext = app.getUpgradeHandler();
const relay = createNeevRelay();
const gcpRelay = createNeevRelay({
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
    return url.origin;
  },
}, GCP_RELAY_PREFIX);
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

let draining = false;
const eventStreams = new Set<ServerResponse>();
server = createServer((req, res) => {
  // Counted until its response is done (or the client goes): a shutdown
  // waits for it. One that comes in on a kept-alive connection while the
  // server drains is still answered, and told to close.
  // An event stream is let go of as soon as it's seen to be one, and ended
  // by the shutdown (lib/observability/streams.ts).
  const release = holdOpen();
  res.once("close", release);
  watchEventStream(res, release, eventStreams);
  if (draining) res.setHeader("connection", "close");
  if (!previews.handle(req, res)) void handle(req, res);
})
  .on("upgrade", (req, socket, head) => {
    if (previews.upgrade(req, socket, head)) return;
    if (!gcpRelay(req, socket, head) && !relay(req, socket, head)) void upgradeNext(req, socket, head);
  })
  .listen(port, () => console.log(`> Ready on http://localhost:${port}`));

/**
 * A graceful exit. On SIGTERM (Cloudflare replacing the container for a new
 * deploy, or putting it to sleep): stop taking new connections; close the
 * terminal and conversation relays with 1012 ("service restart") and end
 * event streams, both of which the browser answers by reconnecting, through
 * the Worker, to the new container; wait up to DRAIN_MS for the requests under way and every
 * after() (a session's setup, a cron job's work) to end; send Sentry what's
 * queued; exit.
 */
let shuttingDown: Promise<void> | null = null;
/** The exit code: an uncaught exception during a SIGTERM's drain still
 *  makes it a failure. */
let exitCode = 0;
function shutdown(why: string, code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code);
  shuttingDown ??= (async () => {
    draining = true;
    startDraining();
    console.log(`> ${why}: draining (${pendingWork()} under way, up to ${DRAIN_MS / 1000}s)`);
    // Whatever happens below, the process ends.
    setTimeout(() => process.exit(exitCode), DRAIN_MS + 5_000).unref();
    if (!server) {
      // Still starting: nothing to drain.
      await flushReports(2_000);
      process.exit(exitCode);
    }
    server.close();
    server.closeIdleConnections();
    const relayed = relay.closeAll(SERVICE_RESTART, "Server restarting") + gcpRelay.closeAll(SERVICE_RESTART, "Server restarting");
    if (relayed) console.log(`> Closed ${relayed} relayed connection(s) for the browser to reconnect`);
    // Event streams never finish on their own; the browser's EventSource
    // reconnects, through the Worker, to the new container.
    const streams = eventStreams.size;
    for (const stream of eventStreams) stream.destroy();
    if (streams) console.log(`> Ended ${streams} event stream(s) for the browser to reconnect`);
    const done = await drained(DRAIN_MS);
    if (!done) console.error(`> ${pendingWork()} request(s) or after() work still under way after ${DRAIN_MS / 1000}s; exiting regardless`);
    else console.log("> Drained");
    await flushReports(2_000);
    process.exit(exitCode);
  })();
  return shuttingDown;
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
