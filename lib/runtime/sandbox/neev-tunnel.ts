import { createServer, type AddressInfo, type Socket } from "node:net";

import { Neev } from "@neevcloud/sdk";
import ssh2, { type Client } from "ssh2";
import WebSocket, { createWebSocketStream } from "ws";

/**
 * A way into a Neev sandbox's ports from this server, through the sandbox's
 * own runtime (its connect URL, on the project's API key), never a preview
 * URL: Neev asks us not to use those, and their edge refuses WebSocket
 * upgrades. The runtime serves SSH over a WebSocket, authorized by the API
 * key alone. One SSH connection per sandbox carries a TCP connection to the
 * port for each request (`direct-tcpip`), and a loopback listener gives the
 * port an address here: `http://127.0.0.1:<port>` reaches the agent as if it
 * were local, for plain requests and WebSockets alike. The agent still checks
 * its Runtime token on each of them.
 *
 * Next (the control calls) and the custom server (the browser relay,
 * relay.ts) both use this, so it imports nothing from the app: Node runs
 * it as is for the server.
 */

/** The sandbox runtime's SSH user; the WebSocket's API key is the credential. */
const SSH_USER = "neev";
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_KEEPALIVE_MS = 15_000;
/** An SSH connection with nothing forwarded for this long is closed; the next
 *  request opens another. */
const SSH_IDLE_MS = 10 * 60_000;

type Tunnel = { listening: Promise<string>; close(): void };

// One per sandbox port for the whole process: Next's bundle and the custom
// server each load their own copy of this module.
const store = globalThis as { __outrunnerNeevTunnels?: Map<string, Tunnel> };
const tunnels = (store.__outrunnerNeevTunnels ??= new Map<string, Tunnel>());

/**
 * The local base URL that reaches `port` inside a sandbox, opened on first
 * use. `connectUrl` saves a lookup when the caller has it.
 */
export function neevTunnel(sandboxId: string, port: number, connectUrl?: string): Promise<string> {
  const key = `${sandboxId}:${port}`;
  let tunnel = tunnels.get(key);
  if (!tunnel) {
    tunnel = openTunnel(sandboxId, port, connectUrl);
    tunnels.set(key, tunnel);
    const opened = tunnel;
    opened.listening.catch(() => {
      if (tunnels.get(key) === opened) tunnels.delete(key);
    });
  }
  return tunnel.listening;
}

/** Close the ways into a sandbox, as it is deleted. */
export function closeNeevTunnels(sandboxId: string): void {
  for (const [key, tunnel] of tunnels) {
    if (key.startsWith(`${sandboxId}:`)) {
      tunnels.delete(key);
      tunnel.close();
    }
  }
}

function openTunnel(sandboxId: string, port: number, knownConnectUrl?: string): Tunnel {
  let connectUrl = knownConnectUrl;
  let current: Promise<Client> | null = null;
  /** The connection `current` resolved to, once ready. */
  let live: Client | null = null;
  let active = 0;
  let idle: NodeJS.Timeout | undefined;

  const connect = async (): Promise<Client> => {
    connectUrl ??= await connectUrlOf(sandboxId);
    const ws = new WebSocket(`${connectUrl.replace(/\/$/, "").replace(/^http/, "ws")}/v1/ssh`, {
      headers: { authorization: `Bearer ${env("NEEV_API_KEY")}` },
    });
    const ssh = new ssh2.Client();
    return new Promise((resolve, reject) => {
      ssh.once("ready", () => resolve(ssh));
      // Before ready this fails the attempt; after it, close follows.
      ssh.on("error", reject);
      ssh.connect({
        sock: createWebSocketStream(ws),
        username: SSH_USER,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: SSH_KEEPALIVE_MS,
      });
    });
  };

  const client = (): Promise<Client> => {
    if (!current) {
      const attempt = connect();
      current = attempt;
      attempt.then(
        (ssh) => {
          if (current === attempt) live = ssh;
          ssh.once("close", () => drop(ssh));
        },
        () => {
          if (current === attempt) current = null;
          // A resumed sandbox can come back on another URL: look it up again.
          connectUrl = undefined;
        },
      );
    }
    return current;
  };

  const drop = (ssh: Client) => {
    if (live !== ssh) return;
    live = null;
    current = null;
  };

  const forward = async (socket: Socket, retry: boolean): Promise<void> => {
    let ssh: Client;
    try {
      ssh = await client();
    } catch {
      socket.destroy();
      return;
    }
    ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) => {
      if (error) {
        // A connection that dropped without saying so: open a fresh one, once.
        drop(ssh);
        ssh.end();
        if (retry && !socket.destroyed) void forward(socket, false);
        else socket.destroy();
        return;
      }
      active += 1;
      clearTimeout(idle);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        active -= 1;
        if (active === 0) {
          idle = setTimeout(() => ssh.end(), SSH_IDLE_MS);
          idle.unref();
        }
      };
      socket.pipe(stream).pipe(socket);
      stream.on("close", () => {
        socket.destroy();
        finish();
      });
      socket.on("close", () => {
        stream.destroy();
        finish();
      });
      stream.on("error", () => socket.destroy());
      socket.on("error", () => stream.destroy());
    });
  };

  const server = createServer((socket) => void forward(socket, true));
  // The process lives on its server; a tunnel alone shouldn't keep it up.
  server.unref();
  const listening = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

  return {
    listening,
    close() {
      clearTimeout(idle);
      server.close();
      void current?.then((ssh) => ssh.end(), () => {});
      current = null;
      live = null;
    },
  };
}

async function connectUrlOf(sandboxId: string): Promise<string> {
  const neev = new Neev({
    apiKey: env("NEEV_API_KEY"),
    orgId: env("NEEV_ORG_ID"),
    projectId: env("NEEV_PROJECT_ID"),
    baseURL: process.env.NEEV_BASE_URL || undefined,
  });
  const sandbox = await neev.sandboxes.get(sandboxId);
  if (!sandbox.connectUrl) {
    throw new Error(`Neev sandbox ${sandboxId} has no connect URL (phase ${sandbox.phase})`);
  }
  return sandbox.connectUrl;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
