import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytonaio/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { NOVNC_PORT } from "@/lib/runtime/box-ports";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import type { ListedBox } from "@/lib/runtime/orphan-boxes";
import {
  homeOf,
  type AgentEndpoint,
  type BoxResources,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";

/** Longer than a cold snapshot pull; the spike measured ~4s warm. */
const CREATE_TIMEOUT_SECONDS = 180;
/** Signed WS preview lifetime; refreshed on reconnect (Spike 1 finding). */
const SIGNED_URL_TTL_SECONDS = 300;
/** How long a preview's way to its port lasts: well past the five minutes
 *  the gate uses one for (lib/previews/upstream.ts), so it never expires in
 *  use, and short, since one leaked can't be told from the gate's own. */
const PREVIEW_TARGET_TTL_SECONDS = 15 * 60;
/**
 * How long one command on a box may run. The SDK puts no deadline on a
 * command given none, so a call Daytona never answers held a session's setup
 * on "Starting Claude" for good, the box idle. Generous: a large repository's
 * first clone and Claude Code's install are the longest, a few minutes each.
 * Past it the command is ended and its step fails, naming it.
 */
export const EXEC_TIMEOUT_SECONDS = 10 * 60;
/** The SDK's deadline for its other calls (get, start, uploads), 24 hours
 *  unless set: none of them takes minutes. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The desktop's screen size. Daytona's computer use starts its display at the
 * VNC_RESOLUTION in the box's environment, 1024×768 without one, and reads it
 * only from the environment the box was made with: a box made before this
 * keeps 1024×768. Wider is more of a web page per screenshot; no wider than
 * this so a screenshot reaches the model at full size, its pixels the ones
 * the agent clicks.
 */
export const DESKTOP_RESOLUTION = "1280x800";

/**
 * How long starting the desktop may take before it's given up: a cold start
 * takes a second or two, so one that hasn't answered in this is stuck, and
 * the Desktop tab should say so and offer a retry, not wait out the SDK's
 * five minutes.
 */
const DESKTOP_START_TIMEOUT_MS = 30_000;

/** `promise`, or a rejection saying `message` once `ms` have gone by. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (${ms / 1000} s)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
      if (this.apiKey) return new Daytona({ apiKey: await this.apiKey(), requestTimeoutMs: REQUEST_TIMEOUT_MS });
      return new Daytona({
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
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

  // Sized by Daytona's own snapshot of its base image at that size (claude
  // + node ship with it), which starts as fast as the base box: sizing one
  // any other way means building it from a full image, slow to first start.
  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const snapshot = size && daytonaSnapshotFor(size);
    const sandbox = await (await this.daytona()).create(
      // Never auto-stopped or auto-deleted by Daytona: Outrunner stops an
      // idle box itself (lib/billing/reconcile.ts), by what its sessions are
      // doing.
      {
        autoStopInterval: 0,
        autoDeleteInterval: -1,
        labels,
        envVars: { VNC_RESOLUTION: DESKTOP_RESOLUTION },
        ...(snapshot && { snapshot }),
      },
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

  /** The account's boxes carrying `labels`, made and last active before
   *  `quietSince`: for the orphaned-box sweep (lib/runtime/orphan-boxes.deps.ts). */
  async *list(labels: Record<string, string>, quietSince: Date): AsyncIterable<ListedBox> {
    const query = { labels, createdAtBefore: quietSince, lastActivityBefore: quietSince };
    for await (const sandbox of (await this.daytona()).list(query)) {
      yield {
        id: sandbox.id,
        labels: sandbox.labels ?? {},
        state: sandbox.state,
        createdAt: sandbox.createdAt,
        lastActivityAt: sandbox.lastActivityAt,
      };
    }
  }

  async pause(id: string): Promise<void> {
    await (await (await this.daytona()).get(id)).stop();
  }

  /** The stopped box `id`, started again on the disk it kept, with `labels`
   *  on it. Null when it's gone or broken, so a new box is the only way on. */
  async restore(id: string, labels: Record<string, string> = {}): Promise<SandboxBox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await (await this.daytona()).get(id);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
    // Still going down: stopping, or archiving, which Daytona does to a box
    // stopped a week. Its disk is kept, so it's waited out and started, not
    // taken for gone (that started a new box, and the session's files were
    // left on this one).
    const state = await settled(sandbox);
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
    await relabel(sandbox, labels);
    return box(sandbox);
  }
}

/** Put `labels` on a box made before them (the deployment's, which the
 *  orphaned-box sweep goes by), keeping its others. Best effort: the box is
 *  up either way. Exported for tests. */
export async function relabel(sandbox: Sandbox, labels: Record<string, string>): Promise<void> {
  const current = sandbox.labels ?? {};
  if (Object.entries(labels).every(([key, value]) => current[key] === value)) return;
  await sandbox
    .setLabels({ ...current, ...labels })
    .catch((error: unknown) => console.warn(`Could not label Daytona box ${sandbox.id}`, error));
}

/**
 * Daytona's sizes of its base image, largest first. The base box, with no
 * snapshot, is the smallest: 1 vCPU and 1 GiB, which a large install and a
 * test run at once can run out of.
 */
const DAYTONA_SNAPSHOTS = [
  { name: "daytona-large", cpu: 4, memoryGb: 8 },
  { name: "daytona-medium", cpu: 2, memoryGb: 4 },
] as const;

/** The largest of Daytona's sizes within `size`'s vCPUs (what the box is
 *  billed by, lib/billing/hours.ts); none, the base box, below them all.
 *  Exported for tests. */
export function daytonaSnapshotFor(size: BoxResources): string | undefined {
  return DAYTONA_SNAPSHOTS.find((s) => s.cpu <= size.cpu)?.name;
}

/** States a box is started again from, ones it's on its way up in, and
 *  ones it's on its way down in, keeping its disk. */
const STOPPED_STATES = new Set(["stopped", "archived"]);
const STARTING_STATES = new Set(["starting", "restoring", "creating"]);
const SETTLING_STATES = new Set(["stopping", "archiving"]);
/** How often a box going down is looked at again. */
const SETTLE_POLL_MS = 2_000;
/** Leave room in the 60s lifecycle/attach routes to return a retryable error. */
export const SETTLE_TIMEOUT_SECONDS = 30;

/**
 * The box's state once it's no longer on its way down (SETTLING_STATES),
 * looked at again every `pollMs`. Throws when it still is after
 * `timeoutSeconds`: the box is there, so trying again later is the way on,
 * never a new box. Exported for tests.
 */
export async function settled(
  sandbox: Pick<Sandbox, "id" | "state" | "refreshData">,
  timeoutSeconds = SETTLE_TIMEOUT_SECONDS,
  pollMs = SETTLE_POLL_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (SETTLING_STATES.has(sandbox.state ?? "unknown")) {
    if (Date.now() >= deadline) throw new Error(`Daytona box ${sandbox.id} is still ${sandbox.state}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    await sandbox.refreshData();
  }
  return sandbox.state ?? "unknown";
}

/** A box's commands and files, from its sandbox. Exported for tests. */
export function box(sandbox: Sandbox): SandboxBox {
  const io: BoxIO = {
    exec: async (command) => {
      const res = await sandbox.process.executeCommand(command, undefined, undefined, EXEC_TIMEOUT_SECONDS);
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
      EXEC_TIMEOUT_SECONDS,
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
    desktop: {
      // Starts what isn't running (the display, its window manager, the VNC
      // server and noVNC) and leaves what is: a second start is a no-op.
      start: async () => {
        await withTimeout(sandbox.computerUse.start(), DESKTOP_START_TIMEOUT_MS, "Daytona's desktop didn't start in time");
      },
      // A signed preview link is good for its one port alone (checked on a
      // real box: the token in it is refused on any other), and noVNC's
      // proxy there forwards to the VNC server alone, a target fixed at its
      // launch that no client can change. So the link reaches the desktop,
      // and not the agent or Daytona's toolbox.
      viewerUrl: async (ttlSeconds) => {
        const url = new URL((await sandbox.getSignedPreviewUrl(NOVNC_PORT, ttlSeconds)).url);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
        url.pathname = "/websockify";
        return url.toString();
      },
    },
    // The signed link, its credential good for this one port, and for a
    // quarter of an hour: the standard link's token is the sandbox's, good
    // for every port, the agent's among them, and a header the box's
    // server might be sent and show. The signed link is the Host the box's
    // server may be sent, and so may echo in a page it builds from it,
    // which is why it lasts minutes and is expired as soon as the preview
    // is deleted or made sign-in only (lib/previews/upstream.ts). Daytona's
    // proxy routes by the host, and would show browsers its own warning
    // page before the user's server without the skip header.
    previewTarget: async (port) => {
      const signed = await sandbox.getSignedPreviewUrl(port, PREVIEW_TARGET_TTL_SECONDS);
      return {
        baseUrl: signed.url,
        headers: { "x-daytona-skip-preview-warning": "true" },
        hostHeader: "upstream",
        revoke: () => sandbox.expireSignedPreviewUrl(port, signed.token),
      };
    },
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
