/**
 * The web app's HTTP server: Next, plus the relay for Neev sessions' live
 * terminal and conversation (lib/runtime/sandbox/neev-relay.ts), which are
 * WebSockets and so can't be route handlers. Every other upgrade (Next's HMR)
 * goes to Next. `pnpm dev` and `pnpm start` run it; Node strips the types.
 */
import { createServer } from "node:http";

import next from "next";

import { createNeevRelay } from "./lib/runtime/sandbox/neev-relay.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

const app = next({ dev, port });
const handle = app.getRequestHandler();
await app.prepare();
const upgradeNext = app.getUpgradeHandler();
const relay = createNeevRelay();

createServer((req, res) => void handle(req, res))
  .on("upgrade", (req, socket, head) => {
    if (!relay(req, socket, head)) void upgradeNext(req, socket, head);
  })
  .listen(port, () => console.log(`> Ready on http://localhost:${port}`));
