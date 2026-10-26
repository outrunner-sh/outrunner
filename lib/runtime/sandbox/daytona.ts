import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytonaio/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import {
  homeOf,
  type AgentEndpoint,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";

/** Longer than a cold snapshot pull; the spike measured ~4s warm. */
const CREATE_TIMEOUT_SECONDS = 180;
/** Signed WS preview lifetime; refreshed on reconnect (Spike 1 finding). */
const SIGNED_URL_TTL_SECONDS = 300;

/** Monotonic suffix so each detached launch gets its own Daytona session. */
let launchSeq = 0;

/**
 * Daytona sandboxes: the deployment's account (DAYTONA_API_KEY, optional
 * DAYTONA_API_URL / _TARGET), or a user's own, on the key `apiKey` reads (for
 * Settings → Sandbox; their account's default region).
 */
export class DaytonaBackend implements SandboxBackend {
  private client: Promise<Daytona> | null = null;
  private readonly apiKey: (() => Promise<string>) | undefined;

  constructor(options: { apiKey?: () => Promise<string> } = {}) {
    this.apiKey = options.apiKey;
  }

  /** Lazy so constructing the backend (e.g. in a test) needs no credentials. */
  private daytona(): Promise<Daytona> {
    this.client ??= (async () => {
      if (this.apiKey) return new Daytona({ apiKey: await this.apiKey() });
      return new Daytona({
        apiKey: requireEnv("DAYTONA_API_KEY"),
        apiUrl: optionalEnv("DAYTONA_API_URL"),
        target: optionalEnv("DAYTONA_TARGET"),
      });
    })();
    // A key that couldn't be read is asked for again next time.
    this.client.catch(() => {
      this.client = null;
    });
    return this.client;
  }

  // No size: Daytona's base box has a fixed one, and sizing a box means
  // building it from a full image, which makes its first start slow.
  async create(labels: Record<string, string>): Promise<SandboxBox> {
    const sandbox = await (await this.daytona()).create(
      // Never auto-stopped or auto-deleted by Daytona: Outrunner stops an
      // idle box itself (lib/billing/reconcile.ts), by what its sessions are
      // doing. Base image (no snapshot): claude + node ship with it.
      { autoStopInterval: 0, autoDeleteInterval: -1, labels },
      { timeout: CREATE_TIMEOUT_SECONDS },
    );
    return box(sandbox);
  }

  async get(id: string): Promise<SandboxBox> {
    return box(await (await this.daytona()).get(id));
  }

  async alive(id: string): Promise<boolean> {
    try {
      return (await (await this.daytona()).get(id)).state === "started";
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return false;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const daytona = await this.daytona();
    await daytona.delete(await daytona.get(id));
  }

  async pause(id: string): Promise<void> {
    await (await (await this.daytona()).get(id)).stop();
  }

  /** The stopped box `id`, started again on the disk it kept. Null when it's
   *  gone or broken, so a new box is the only way on. */
  async restore(id: string): Promise<SandboxBox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await (await this.daytona()).get(id);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
    const state = sandbox.state ?? "unknown";
    if (STOPPED_STATES.has(state)) {
      try {
        await sandbox.start(CREATE_TIMEOUT_SECONDS);
      } catch (error) {
        // Stopped again rather than left starting where nothing meters or
        // stops it: its computer is saved stopped, which the reconciler
        // doesn't check.
        await sandbox.stop().catch((stopError: unknown) => console.error(`Could not stop box ${id} again`, stopError));
        throw error;
      }
    } else if (STARTING_STATES.has(state)) await sandbox.waitUntilStarted(CREATE_TIMEOUT_SECONDS);
    else if (state !== "started") {
      // Gone or broken, not stopped: a new box rather than retrying this one.
      console.error(`Daytona box ${id} is ${state}, not stopped; starting a new one`);
      return null;
    }
    return box(sandbox);
  }
}

/** States a box is started again from, and ones it's on its way up in. */
const STOPPED_STATES = new Set(["stopped", "archived"]);
const STARTING_STATES = new Set(["starting", "restoring", "creating"]);

function box(sandbox: Sandbox): SandboxBox {
  const io: BoxIO = {
    exec: async (command) => {
      const res = await sandbox.process.executeCommand(command);
      return { stdout: res.result ?? "", exitCode: res.exitCode ?? 0 };
    },
    // Through a background session with runAsync: a synchronous
    // executeCommand never returns while the daemon it started keeps running
    // (the provisioning spike's `agent_boot` hang). A UNIQUE session per
    // launch: the jcode path launches two daemons, and reusing one session id
    // makes the second collide with the still-running first and silently not
    // execute.
    launch: async (command) => {
      launchSeq += 1;
      const sessionId = `runtime-launch-${sandbox.id}-${launchSeq}`;
      await sandbox.process.createSession(sessionId).catch(() => {});
      await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true });
    },
    upload: (data, remotePath) => sandbox.fs.uploadFile(data, remotePath),
  };
  // Argv is shell-quoted and wrapped in `bash -lc`; the credential token rides
  // in the process env (never in argv), exactly as on the local/modal paths.
  const gitExec: GitExec = async (argv, options) => {
    const inner = argv.map(shellQuote).join(" ");
    const res = await sandbox.process.executeCommand(
      `bash -lc ${shellQuote(inner)}`,
      undefined,
      options?.env,
    );
    return { stdout: res.result ?? "", stderr: "", exitCode: res.exitCode ?? 0 };
  };
  return {
    id: sandbox.id,
    cpu: sandbox.cpu,
    io,
    gitExec,
    // Default images aren't /home/runtime; the agent + mirror hang off $HOME.
    home: () => homeOf(io, "/home/daytona"),
    // Both preview flavors: standard for control calls (token as a header),
    // signed for the browser WS (token already in the host).
    agentEndpoint: async (port): Promise<AgentEndpoint> => {
      const [preview, signed] = await Promise.all([
        sandbox.getPreviewLink(port),
        sandbox.getSignedPreviewUrl(port, SIGNED_URL_TTL_SECONDS),
      ]);
      return {
        controlBaseUrl: preview.url,
        controlHeaders: { "x-daytona-preview-token": preview.token },
        wsBaseUrl: signed.url,
      };
    },
    // The token is in the host, so every page, asset and socket under it is
    // let through: what the editor needs.
    browserUrl: async (port, ttlSeconds) => (await sandbox.getSignedPreviewUrl(port, ttlSeconds)).url,
  };
}

/** Whether Daytona accepts `apiKey` (Settings → Sandbox checks one before
 *  saving it): false when it refuses it, a throw when it can't be asked. */
export async function daytonaAcceptsKey(apiKey: string): Promise<boolean> {
  try {
    await new Daytona({ apiKey }).list().next();
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401 || status === 403) return false;
    throw error;
  }
}
