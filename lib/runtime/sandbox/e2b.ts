import { CommandExitError, NotFoundError, Sandbox, type SandboxInfo } from "e2b";

import { optionalEnv, requireEnv } from "@/lib/env";
import { BOX_IMAGE_TAG } from "@/lib/runtime/box-image";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import {
  BOX_USER,
  homeOf,
  type AgentEndpoint,
  type BoxResources,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";
import { e2bRoute } from "@/lib/runtime/sandbox/e2b-route";
import { E2B_RELAY_PREFIX, mintRelayTicket, relayKey } from "@/lib/runtime/sandbox/relay-ticket";

/**
 * How long a box runs before E2B pauses it on its own (lifecycle onTimeout
 * "pause", memory kept). Outrunner pauses idle boxes itself; this is the
 * backstop, and {@link E2bBackend.get} pushes it back out once half is gone,
 * so a box in use isn't paused under its session. It must be within the E2B team's
 * max_length_hours, or E2B refuses the box.
 */
export const BOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** How long one command may run: as on Daytona, a large repository's first
 *  clone is the longest. 0 would let a stuck command hold a session for good. */
export const EXEC_TIMEOUT_MS = 10 * 60 * 1000;
/** The SDK's deadline for its own calls (create, connect, info). */
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/** The template every box is made from: box/Dockerfile built for E2B by
 *  scripts/e2b-template.ts, named for the image tag so a box never runs tools
 *  at versions the agent wasn't built for. E2B_TEMPLATE overrides it. */
export function e2bTemplate(): string {
  return optionalEnv("E2B_TEMPLATE") ?? `outrunner-box-${BOX_IMAGE_TAG}`;
}

/**
 * The guest MTU to set on every box as it comes up, from E2B_GUEST_MTU; null
 * to leave E2B's. Needed where the host's network carries smaller packets than
 * a box's 1500 (GCP's VPC is 1460), which otherwise cuts large downloads off
 * part way. A box comes up at 1500 whatever its template set, so it's set on
 * each create and resume.
 */
export function guestMtu(value = optionalEnv("E2B_GUEST_MTU")): number | null {
  if (!value) return null;
  const mtu = Number(value);
  if (!Number.isInteger(mtu) || mtu < 576 || mtu > 9000) {
    throw new Error(`E2B_GUEST_MTU must be a whole number from 576 to 9000, not "${value}".`);
  }
  return mtu;
}

/** The SDK's connection, on the deployment's own E2B (an Embed or a cluster).
 *  Both URLs are required: unset, the SDK would quietly use E2B's cloud, and
 *  a box made there couldn't be reached through E2B_SANDBOX_URL after. */
function connection() {
  return {
    apiKey: requireEnv("E2B_API_KEY"),
    apiUrl: requireEnv("E2B_API_URL"),
    sandboxUrl: requireEnv("E2B_SANDBOX_URL"),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
}

/** Whether `error` is E2B saying the box doesn't exist (killed, or never was). */
function notFound(error: unknown): boolean {
  return error instanceof NotFoundError;
}

/**
 * Each running box's SDK handle in this server, with the start it belongs to
 * (E2B gives a box a new startedAt each time it resumes). Getting a handle
 * means E2B's connect, which resumes a paused box; reusing it keeps
 * {@link E2bBackend.get} to one call and never resumes anything. Dropped
 * when the box is paused or deleted here, and unused once its start changes.
 */
const HANDLES = new Map<string, { sandbox: Sandbox; startedAt: number }>();

/** Forget every handle: a test seam. */
export function forgetE2bHandles(): void {
  HANDLES.clear();
}

/**
 * Push a running box's backstop timeout back out to {@link BOX_TIMEOUT_MS}
 * once less than half of it is left, so a box in use isn't paused under its
 * session, without a write to E2B on every call. Best effort: a box that
 * can't be extended now has hours left to try again.
 */
async function keepAlive(info: Pick<SandboxInfo, "sandboxId" | "endAt">, now = Date.now()): Promise<void> {
  if (info.endAt.getTime() - now >= BOX_TIMEOUT_MS / 2) return;
  await Sandbox.setTimeout(info.sandboxId, BOX_TIMEOUT_MS, connection()).catch((error: unknown) =>
    console.warn(`Could not extend E2B box ${info.sandboxId}'s timeout`, error),
  );
}

/**
 * Outrunner's boxes on the deployment's own E2B (RUNTIME_PROVIDER=e2b):
 * Firecracker VMs that pause with their memory, so a resumed box has its
 * agent, tmux and sessions still running. One box size for now, the
 * template's (Small); a request for another is logged and given that.
 */
export class E2bBackend implements SandboxBackend {
  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const sandbox = await Sandbox.create(e2bTemplate(), {
      ...connection(),
      metadata: labels,
      timeoutMs: BOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause" },
    });
    try {
      const info = await Sandbox.getInfo(sandbox.sandboxId, connection());
      if (size && (info.cpuCount !== size.cpu || info.memoryMB !== size.memoryGb * 1024)) {
        console.warn(
          `E2B box ${sandbox.sandboxId}: requested ${size.cpu} vCPU / ${size.memoryGb} GiB; ` +
            `received ${info.cpuCount} vCPU / ${info.memoryMB / 1024} GiB (template ${e2bTemplate()})`,
        );
      }
      await setGuestMtu(sandbox);
      HANDLES.set(sandbox.sandboxId, { sandbox, startedAt: info.startedAt.getTime() });
      return box(sandbox, info);
    } catch (error) {
      // Not left running where nothing records it.
      await Sandbox.kill(sandbox.sandboxId, connection()).catch(() => {});
      throw error;
    }
  }

  /** The box, running. Throws for one that isn't: unlike E2B's connect, this
   *  never resumes a paused box (alive/get must not start one). */
  async get(id: string): Promise<SandboxBox> {
    const info = await Sandbox.getInfo(id, connection());
    if (info.state !== "running") {
      HANDLES.delete(id);
      throw new Error(`E2B box ${id} is ${info.state}, not running`);
    }
    await keepAlive(info);
    const startedAt = info.startedAt.getTime();
    const held = HANDLES.get(id);
    if (held?.startedAt === startedAt) return box(held.sandbox, info);

    // A handle means connect, which resumes a box paused since the look
    // above. A resume gives it a new start, so one that has a new start now
    // was resumed by this call, and is paused again rather than left running
    // where nothing tracks it.
    const sandbox = await Sandbox.connect(id, connection());
    const after = await Sandbox.getInfo(id, connection());
    if (after.startedAt.getTime() !== startedAt) {
      await Sandbox.pause(id, connection()).catch((error: unknown) =>
        console.error(`E2B box ${id} was resumed while being reached and could not be paused again`, error),
      );
      throw new Error(`E2B box ${id} was paused while being reached; it's left paused`);
    }
    HANDLES.set(id, { sandbox, startedAt });
    return box(sandbox, after);
  }

  async alive(id: string): Promise<boolean> {
    try {
      return (await Sandbox.getInfo(id, connection())).state === "running";
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    HANDLES.delete(id);
    await Sandbox.kill(id, connection());
  }

  /** Pause with its memory: the next {@link restore} has it as it was. */
  async pause(id: string): Promise<void> {
    HANDLES.delete(id);
    await Sandbox.pause(id, connection());
  }

  /** The paused (or still running) box `id`, running. Null when it's gone,
   *  so a new box is the only way on. E2B's metadata can't be changed after
   *  create, so `labels` stay as the box was made with. */
  async restore(id: string): Promise<SandboxBox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.connect(id, { ...connection(), timeoutMs: BOX_TIMEOUT_MS });
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    try {
      await setGuestMtu(sandbox);
      const info = await Sandbox.getInfo(id, connection());
      HANDLES.set(id, { sandbox, startedAt: info.startedAt.getTime() });
      return box(sandbox, info);
    } catch (error) {
      // Resumed but not usable: paused again, keeping its sessions (this is
      // their only copy), rather than left running with nothing tracking it.
      await Sandbox.pause(id, connection()).catch((pauseError: unknown) =>
        console.error(`Could not pause E2B box ${id} again`, pauseError),
      );
      throw error;
    }
  }
}

/** Set E2B_GUEST_MTU on the box's interface, as root (the box user's sudo is
 *  the image's, and this must not depend on it). */
async function setGuestMtu(sandbox: Sandbox): Promise<void> {
  const mtu = guestMtu();
  if (mtu === null) return;
  await sandbox.commands.run(`ip link set eth0 mtu ${mtu}`, { user: "root", timeoutMs: 30_000 });
}

/** A command's output and exit code, a non-zero exit included: E2B throws
 *  for one, where the callers here read the code. */
async function run(
  sandbox: Sandbox,
  command: string,
  envs?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sandbox.commands.run(command, { user: BOX_USER, envs, timeoutMs: EXEC_TIMEOUT_MS });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (error) {
    if (error instanceof CommandExitError) {
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
    }
    throw error;
  }
}

/** A box's commands, files and ways in, from its sandbox. Exported for tests. */
export function box(sandbox: Sandbox, info: Pick<SandboxInfo, "cpuCount" | "memoryMB">): SandboxBox {
  const id = sandbox.sandboxId;
  const io: BoxIO = {
    exec: async (command) => {
      const { stdout, exitCode } = await run(sandbox, command);
      return { stdout, exitCode };
    },
    // In the background, with no deadline: the agent is a daemon that must
    // outlive this call. The handle is let go; the process keeps running.
    launch: async (command) => {
      const handle = await sandbox.commands.run(command, { user: BOX_USER, background: true, timeoutMs: 0 });
      await handle.disconnect();
    },
    upload: async (data, remotePath) => {
      await sandbox.files.write(remotePath, new Uint8Array(data), { user: BOX_USER });
    },
  };
  // Argv is shell-quoted and wrapped in `bash -lc`; the credential rides in
  // the process env, never in argv, as on every other provider.
  const gitExec: GitExec = (argv, options) =>
    run(sandbox, `bash -lc ${shellQuote(argv.map(shellQuote).join(" "))}`, options?.env);
  return {
    id,
    cpu: info.cpuCount,
    memoryGb: info.memoryMB / 1024,
    io,
    gitExec,
    home: () => homeOf(io, `/home/${BOX_USER}`),
    // Control calls go straight to E2B's proxy with its routing headers; the
    // browser can't send those, so its WebSockets come through our relay.
    agentEndpoint: async (port): Promise<AgentEndpoint> => {
      const route = e2bRoute(id, port, requireEnv("E2B_SANDBOX_URL"));
      const ticket = mintRelayTicket(id, port, relayKey(requireEnv("CREDENTIALS_ENCRYPTION_KEY"), "e2b"));
      return {
        controlBaseUrl: route.base,
        controlHeaders: route.headers,
        wsBaseUrl: `${requireEnv("RUNTIME_BASE_URL")}${E2B_RELAY_PREFIX}${id}/${port}/${ticket}`,
      };
    },
    // E2B's proxy routes by the headers, and sends the box's server the
    // Host it was asked on.
    previewTarget: async (port) => {
      const route = e2bRoute(id, port, requireEnv("E2B_SANDBOX_URL"));
      return { baseUrl: route.base, headers: route.headers, hostHeader: "upstream" };
    },
  };
}
