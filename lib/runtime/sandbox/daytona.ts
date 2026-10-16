import { Daytona, type Sandbox } from "@daytonaio/sdk";

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

/** Daytona sandboxes (DAYTONA_API_KEY, optional DAYTONA_API_URL / _TARGET). */
export class DaytonaBackend implements SandboxBackend {
  private client: Daytona | null = null;

  /** Lazy so constructing the backend (e.g. in a test) needs no credentials. */
  private daytona(): Daytona {
    if (!this.client) {
      this.client = new Daytona({
        apiKey: requireEnv("DAYTONA_API_KEY"),
        apiUrl: optionalEnv("DAYTONA_API_URL"),
        target: optionalEnv("DAYTONA_TARGET"),
      });
    }
    return this.client;
  }

  async create(labels: Record<string, string>): Promise<SandboxBox> {
    const sandbox = await this.daytona().create(
      // Always-on: never auto-stop, never auto-delete. Base image (no
      // snapshot): claude + node ship with it.
      { autoStopInterval: 0, autoDeleteInterval: -1, labels },
      { timeout: CREATE_TIMEOUT_SECONDS },
    );
    return box(sandbox);
  }

  async get(id: string): Promise<SandboxBox> {
    return box(await this.daytona().get(id));
  }

  async alive(id: string): Promise<boolean> {
    return (await this.daytona().get(id)).state === "started";
  }

  async delete(id: string): Promise<void> {
    await this.daytona().delete(await this.daytona().get(id));
  }
}

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
  };
}
