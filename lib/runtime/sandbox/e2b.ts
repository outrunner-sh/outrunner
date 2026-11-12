import { createHash } from "node:crypto";

import { CommandExitError, NotFoundError, Sandbox, type SandboxInfo } from "e2b";

import { optionalEnv, requireEnv } from "@/lib/env";
import { E2B_TEMPLATE_TAG } from "@/lib/runtime/e2b-template";
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
import { NOVNC_PORT } from "@/lib/runtime/box-ports";
import { E2B_TRAFFIC_TOKEN_HEADER, e2bRoute, sealableE2bRelaySecret } from "@/lib/runtime/sandbox/e2b-route";
import { e2bSdkOptions } from "@/lib/runtime/sandbox/e2b-sdk";
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

/** The template every box is made from: box/Dockerfile and the desktop built
 *  for E2B by scripts/e2b-template.ts, named for the template tag so a box
 *  never runs tools at versions the agent wasn't built for.
 *  OUTRUNNER_E2B_TEMPLATE overrides it. */
export function e2bTemplate(): string {
  return optionalEnv("OUTRUNNER_E2B_TEMPLATE") ?? `outrunner-box-${E2B_TEMPLATE_TAG}`;
}

/**
 * The guest MTU to set on every box as it comes up, from OUTRUNNER_E2B_GUEST_MTU; null
 * to leave E2B's. Needed where the host's network carries smaller packets than
 * a box's 1500 (GCP's VPC is 1460), which otherwise cuts large downloads off
 * part way. A box comes up at 1500 whatever its template set, so it's set on
 * each create and resume.
 */
export function guestMtu(value = optionalEnv("OUTRUNNER_E2B_GUEST_MTU")): number | null {
  if (!value) return null;
  const mtu = Number(value);
  if (!Number.isInteger(mtu) || mtu < 576 || mtu > 9000) {
    throw new Error(`OUTRUNNER_E2B_GUEST_MTU must be a whole number from 576 to 9000, not "${value}".`);
  }
  return mtu;
}

/**
 * One E2B to make boxes on: the deployment's own (RUNTIME_PROVIDER=e2b, from
 * the environment) or a user's (Settings → Sandbox, from their stored key).
 */
export type E2bConnection = {
  apiKey: string;
  /** The E2B API; unset is E2B's cloud. */
  apiUrl?: string;
  /** A self-hosted E2B's client-proxy, which routes to a box's port by
   *  header: control calls carry them, and browsers, which can't, come through
   *  {@link E2bConnection.relay}. Unset is E2B's cloud, which routes by host
   *  (`<port>-<box>.<domain>`), so control calls and browsers go there direct. */
  sandboxUrl?: string;
  /** Set on every box as it comes up (see {@link guestMtu}); null to leave E2B's. */
  guestMtu: number | null;
  /** How long a box runs before E2B pauses it on its own: the backstop
   *  behind Outrunner's own idle pause, pushed back out while it's in use. */
  timeoutMs: number;
  /** The proxy the SDK's calls go through: for a user's self-hosted E2B, the
   *  egress proxy that reaches only their hosts (e2b-sdk.ts userE2bProxy). */
  proxy?: string;
  /** This server's relay for browsers' WebSockets to a box: its path prefix,
   *  the key its tickets are signed with, and for a user's E2B, the user, bound
   *  into each ticket so the relay reaches only their box. */
  relay: { prefix: string; key: string; owner?: string };
};

/** The deployment's own E2B, from the environment. Both URLs are required:
 *  unset, the SDK would quietly use E2B's cloud, and a box made there
 *  couldn't be reached through OUTRUNNER_E2B_SANDBOX_URL after. */
export function deploymentE2bConnection(): E2bConnection {
  return {
    apiKey: requireEnv("OUTRUNNER_E2B_API_KEY"),
    apiUrl: requireEnv("OUTRUNNER_E2B_API_URL"),
    sandboxUrl: requireEnv("OUTRUNNER_E2B_SANDBOX_URL"),
    guestMtu: guestMtu(),
    timeoutMs: BOX_TIMEOUT_MS,
    relay: { prefix: E2B_RELAY_PREFIX, key: relayKey(requireEnv("CREDENTIALS_ENCRYPTION_KEY"), "e2b") },
  };
}

/** The SDK's options for calls on `c`. */
function sdk(c: E2bConnection) {
  return e2bSdkOptions(c, REQUEST_TIMEOUT_MS);
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

/**
 * Restores of each box in this server: how many have begun, and how many are
 * running now. A get never pauses a box a restore here resumed: one that
 * began while it connected (the begun count moved) or one still running (it
 * began earlier). Counts, not flags, so overlapping restores of one box don't
 * clear each other. Bounded like {@link HANDLES}: by the boxes this server
 * has restored.
 */
const RESTORES_BEGUN = new Map<string, number>();
const RESTORES_RUNNING = new Map<string, number>();

/** How far E2B's clock may be from ours when telling a resume this server's
 *  get caused from someone's restore just before it. */
const CLOCK_SKEW_MS = 2_000;

/**
 * The key a box's handle and restore counts are kept under: its id within
 * the E2B account it's in. A user's E2B picks its own box ids, so an id alone
 * could name another account's box (the deployment's, or another user's),
 * and a handle kept for one must never be handed out for the other.
 */
export function handleKey(c: Pick<E2bConnection, "apiKey" | "apiUrl">, id: string): string {
  const account = createHash("sha256").update(`${c.apiUrl ?? ""}\n${c.apiKey}`).digest("base64url").slice(0, 22);
  return `${account}:${id}`;
}

/** Forget every handle: a test seam. */
export function forgetE2bHandles(): void {
  HANDLES.clear();
}

/**
 * Push a running box's backstop timeout back out to the connection's once
 * less than half of it is left, so a box in use isn't paused under its
 * session, without a write to E2B on every call. Best effort: a box that
 * can't be extended now has half its time left to try again.
 */
async function keepAlive(c: E2bConnection, info: Pick<SandboxInfo, "sandboxId" | "endAt">, now = Date.now()): Promise<void> {
  if (info.endAt.getTime() - now >= c.timeoutMs / 2) return;
  await Sandbox.setTimeout(info.sandboxId, c.timeoutMs, sdk(c)).catch((error: unknown) =>
    console.warn(`Could not extend E2B box ${info.sandboxId}'s timeout`, error),
  );
}

/**
 * Outrunner's boxes on an E2B: the deployment's own (RUNTIME_PROVIDER=e2b) or
 * a user's (Settings → Sandbox). Firecracker VMs that pause with their
 * memory, so a resumed box has its agent, tmux and sessions still running.
 * One box size, the template's (Small); a request for another is logged and
 * given that.
 */
export class E2bBackend implements SandboxBackend {
  private readonly connection: () => Promise<E2bConnection>;
  private readonly template: () => Promise<string>;

  // Plain fields, not parameter properties: Node's strip-only TypeScript
  // (the test runner) can't run those.
  /** `connection` reaches the E2B (the deployment's by default); `template`
   *  is what a new box starts from (a name or an id), asked only on create, so
   *  a template not ready yet stops new boxes and nothing else. */
  constructor(options: { connection?: () => Promise<E2bConnection>; template?: () => Promise<string> } = {}) {
    this.connection = options.connection ?? (async () => deploymentE2bConnection());
    this.template = options.template ?? (async () => e2bTemplate());
  }

  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const [c, template] = await Promise.all([this.connection(), this.template()]);
    const sandbox = await Sandbox.create(template, {
      ...sdk(c),
      metadata: labels,
      timeoutMs: c.timeoutMs,
      lifecycle: { onTimeout: "pause" },
      // Its ports answer only requests with its traffic token, which only
      // this server holds: the agent, previews (behind our login gate) and
      // the desktop aren't open to anyone who learns the box id.
      network: { allowPublicTraffic: false },
    });
    try {
      const info = await Sandbox.getInfo(sandbox.sandboxId, sdk(c));
      if (size && (info.cpuCount !== size.cpu || info.memoryMB !== size.memoryGb * 1024)) {
        console.warn(
          `E2B box ${sandbox.sandboxId}: requested ${size.cpu} vCPU / ${size.memoryGb} GiB; ` +
            `received ${info.cpuCount} vCPU / ${info.memoryMB / 1024} GiB (template ${template})`,
        );
      }
      await setGuestMtu(c, sandbox);
      HANDLES.set(handleKey(c, sandbox.sandboxId), { sandbox, startedAt: info.startedAt.getTime() });
      return box(sandbox, info, c);
    } catch (error) {
      // Not left running where nothing records it.
      await Sandbox.kill(sandbox.sandboxId, sdk(c)).catch(() => {});
      throw error;
    }
  }

  /** The box, running. Throws for one that isn't: unlike E2B's connect, this
   *  never resumes a paused box (alive/get must not start one). */
  async get(id: string): Promise<SandboxBox> {
    const c = await this.connection();
    const k = handleKey(c, id);
    const info = await Sandbox.getInfo(id, sdk(c)).catch((error: unknown) => {
      // Deleted elsewhere (another server, the console): its handle goes too.
      if (notFound(error)) HANDLES.delete(k);
      throw error;
    });
    if (info.state !== "running") {
      HANDLES.delete(k);
      throw new Error(`E2B box ${id} is ${info.state}, not running`);
    }
    await keepAlive(c, info);
    const startedAt = info.startedAt.getTime();
    const held = HANDLES.get(k);
    if (held?.startedAt === startedAt) return box(held.sandbox, info, c);

    // A handle means connect, which resumes a box paused since the look
    // above, and a resume is a new start. A new start that began once this
    // connect was under way is this call's doing: the box is paused again
    // rather than left running where nothing tracks it. One that began
    // before is someone's restore (here or on another server), and is left
    // running. The clocks are E2B's and ours, so a restore within
    // CLOCK_SKEW_MS before the connect is taken for this call's resume, and
    // a restore in this server is never paused under itself.
    const restoresBefore = RESTORES_BEGUN.get(k) ?? 0;
    const connectedAt = Date.now();
    const sandbox = await Sandbox.connect(id, sdk(c));
    const after = await Sandbox.getInfo(id, sdk(c));
    const restarted = after.startedAt.getTime();
    const restoredHere = (RESTORES_BEGUN.get(k) ?? 0) !== restoresBefore || (RESTORES_RUNNING.get(k) ?? 0) > 0;
    if (restarted !== startedAt && restarted >= connectedAt - CLOCK_SKEW_MS && !restoredHere) {
      HANDLES.delete(k);
      await Sandbox.pause(id, sdk(c)).catch((error: unknown) =>
        console.error(`E2B box ${id} was resumed while being reached and could not be paused again`, error),
      );
      throw new Error(`E2B box ${id} was paused while being reached; it's left paused`);
    }
    HANDLES.set(k, { sandbox, startedAt: restarted });
    return box(sandbox, after, c);
  }

  async alive(id: string): Promise<boolean> {
    try {
      return (await Sandbox.getInfo(id, sdk(await this.connection()))).state === "running";
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const c = await this.connection();
    HANDLES.delete(handleKey(c, id));
    await Sandbox.kill(id, sdk(c));
  }

  /** Pause with its memory: the next {@link restore} has it as it was. */
  async pause(id: string): Promise<void> {
    const c = await this.connection();
    HANDLES.delete(handleKey(c, id));
    await Sandbox.pause(id, sdk(c));
  }

  /** The paused (or still running) box `id`, running. Null when it's gone,
   *  so a new box is the only way on. E2B's metadata can't be changed after
   *  create, so `labels` stay as the box was made with. */
  async restore(id: string): Promise<SandboxBox | null> {
    const c = await this.connection();
    const k = handleKey(c, id);
    RESTORES_BEGUN.set(k, (RESTORES_BEGUN.get(k) ?? 0) + 1);
    RESTORES_RUNNING.set(k, (RESTORES_RUNNING.get(k) ?? 0) + 1);
    try {
      return await this.resume(c, id);
    } finally {
      const running = (RESTORES_RUNNING.get(k) ?? 1) - 1;
      if (running > 0) RESTORES_RUNNING.set(k, running);
      else RESTORES_RUNNING.delete(k);
    }
  }

  private async resume(c: E2bConnection, id: string): Promise<SandboxBox | null> {
    const k = handleKey(c, id);
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.connect(id, { ...sdk(c), timeoutMs: c.timeoutMs });
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    try {
      await setGuestMtu(c, sandbox);
      const info = await Sandbox.getInfo(id, sdk(c));
      HANDLES.set(k, { sandbox, startedAt: info.startedAt.getTime() });
      return box(sandbox, info, c);
    } catch (error) {
      // Resumed but not usable: paused again, keeping its sessions (this is
      // their only copy), rather than left running with nothing tracking it.
      await Sandbox.pause(id, sdk(c)).catch((pauseError: unknown) =>
        console.error(`Could not pause E2B box ${id} again`, pauseError),
      );
      throw error;
    }
  }
}

/** Set the connection's guest MTU on the box's interface, as root (the box
 *  user's sudo is the image's, and this must not depend on it). */
async function setGuestMtu(c: E2bConnection, sandbox: Sandbox): Promise<void> {
  if (c.guestMtu === null) return;
  await sandbox.commands.run(`ip link set eth0 mtu ${c.guestMtu}`, { user: "root", timeoutMs: 30_000 });
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
export function box(sandbox: Sandbox, info: Pick<SandboxInfo, "cpuCount" | "memoryMB">, c: E2bConnection): SandboxBox {
  const id = sandbox.sandboxId;
  // Every way into the box's ports carries its traffic token (a box from
  // before allowPublicTraffic: false has none, and needs none).
  const trafficToken = sandbox.trafficAccessToken;
  // How this server reaches the box's `port`: by header through a self-hosted
  // client-proxy, or at the box's own host on E2B's cloud.
  // What the relay's ticket carries sealed: the token, and a user's box's owner.
  const secret = sealableE2bRelaySecret({ token: trafficToken, owner: c.relay.owner });
  const route = (port: number) =>
    c.sandboxUrl
      ? e2bRoute(id, port, c.sandboxUrl, trafficToken)
      : {
          base: `https://${sandbox.getHost(port)}`,
          headers: trafficToken ? { [E2B_TRAFFIC_TOKEN_HEADER]: trafficToken } : ({} as Record<string, string>),
        };
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
    // Control calls go to the box's port with whatever routing E2B needs.
    agentEndpoint: async (port): Promise<AgentEndpoint> => {
      const { base, headers } = route(port);
      // A browser can send neither routing headers nor the traffic token, so
      // its WebSockets come through our relay, the token sealed in the ticket
      // (with the box's owner, for a user's E2B) out of the browser's reach.
      // Only a host-routed box from before traffic tokens is opened direct.
      const wsBaseUrl =
        c.sandboxUrl || trafficToken
          ? `${requireEnv("RUNTIME_BASE_URL")}${c.relay.prefix}${id}/${port}/${mintRelayTicket(id, port, c.relay.key, Date.now(), { secret })}`
          : base;
      return { controlBaseUrl: base, controlHeaders: headers, wsBaseUrl };
    },
    // Through E2B's proxy, which sends the box's server the Host it was asked on.
    previewTarget: async (port) => {
      const { base, headers } = route(port);
      return { baseUrl: base, headers, hostHeader: "upstream" };
    },
    // The template's desktop (box/e2b-desktop.sh), started on first use. Each
    // link comes with a new VNC password, which the box replaces once the
    // link's `ttlSeconds` are up. The link goes through our relay, on a
    // ticket for that port alone lasting as long, which carries the box's
    // traffic token sealed: the noVNC port answers nothing else. Only a box
    // on E2B's cloud from before traffic tokens is opened at its own host.
    desktop: {
      start: async () => {
        await rootCommand(sandbox, "outrunner-desktop start", "start the desktop");
      },
      viewer: async (ttlSeconds) => {
        if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error(`A desktop link's TTL must be whole seconds, not ${ttlSeconds}`);
        const password = (
          await rootCommand(sandbox, `outrunner-desktop password ${ttlSeconds}`, "set the desktop's password")
        ).trim();
        if (!/^[A-Za-z0-9]{8}$/.test(password)) throw new Error("The desktop didn't give a password");
        const url = c.sandboxUrl || trafficToken
          ? `${requireEnv("RUNTIME_BASE_URL").replace(/^http/, "ws")}${c.relay.prefix}${id}/${NOVNC_PORT}/` +
            `${mintRelayTicket(id, NOVNC_PORT, c.relay.key, Date.now(), { secret, ttlSeconds })}/websockify`
          : `wss://${sandbox.getHost(NOVNC_PORT)}/websockify`;
        return { url, password };
      },
    },
  };
}

/** How long starting the desktop may take: a cold start is a few seconds. */
const DESKTOP_COMMAND_TIMEOUT_MS = 60_000;

/** Run `command` on the box as root, for its stdout; a failure says what it
 *  was doing and what the box said. */
async function rootCommand(sandbox: Sandbox, command: string, doing: string): Promise<string> {
  try {
    return (await sandbox.commands.run(command, { user: "root", timeoutMs: DESKTOP_COMMAND_TIMEOUT_MS })).stdout;
  } catch (error) {
    if (error instanceof CommandExitError) {
      throw new Error(`Couldn't ${doing}: ${(error.stderr || error.stdout).trim().slice(0, 300) || `exit ${error.exitCode}`}`);
    }
    throw error;
  }
}
