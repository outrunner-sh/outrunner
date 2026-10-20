import { randomUUID } from "node:crypto";

import { Neev, NotFoundError, type Sandbox } from "@neevcloud/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import {
  asUserArgs,
  BOX_USER,
  IDLE_BACKSTOP_SECONDS,
  type AgentEndpoint,
  type BoxResources,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";
import { mintRelayTicket, NEEV_RELAY_PREFIX } from "@/lib/runtime/sandbox/neev-relay-ticket";
import { closeNeevTunnels, neevTunnel } from "@/lib/runtime/sandbox/neev-tunnel";

/**
 * Neev sandboxes (NeevCloud Agent Sandboxes): NEEV_API_KEY, NEEV_ORG_ID,
 * NEEV_PROJECT_ID, optional NEEV_SANDBOX_TEMPLATE and NEEV_BASE_URL.
 *
 * NEEV_API_KEY is a project API key with Resource Type "Sandboxes"
 * (`sk-nc-…`). It is sent as is to the sandbox's own runtime (its
 * `connect_url`). A personal access token (`pat-nc-…`) gets a 401 there, and
 * connect tokens can't be minted with an API key.
 *
 * What differs from Daytona, all found on real sandboxes:
 *  - Commands and file writes go to the sandbox's runtime directly
 *    ({@link SandboxRuntime}), whose exec takes a login shell and an
 *    environment; the SDK does the rest.
 *  - The sandbox user is root, and Claude refuses bypassPermissions as root.
 *    Preparing the box creates a `runtime` user, and every command after that
 *    runs as it.
 *  - There is no usable sudo (no setuid), so the tools the agent needs (tmux,
 *    Claude Code) are installed here, as root, before the deploy runs.
 *  - Files can only be written under /workspace: an upload lands there and is
 *    moved into place.
 *  - No preview URLs: Neev asks us not to use them, and their edge refuses
 *    WebSocket upgrades. The agent is reached through the sandbox's runtime
 *    instead ({@link neevTunnel}), and the browser's WebSockets through this
 *    server's relay (neev-relay.ts).
 */

const DEFAULT_TEMPLATE = "sb-ubuntu-26-04-dev";
const BOX_HOME = `/home/${BOX_USER}`;
/** Uploads land here (the only writable tree), then move into place. */
const UPLOAD_DIR = "/workspace";
/** Installing tmux and Claude Code measured ~55 s; leave room for a slow mirror. */
const PREPARE_TIMEOUT_MS = 600_000;
const PREPARE_POLL_MS = 3_000;
const PREPARE_LOG = `${UPLOAD_DIR}/.outrunner-prepare.log`;
const PREPARE_EXIT = `${UPLOAD_DIR}/.outrunner-prepare.exit`;

/** Root-side setup: the agent's tools, and the user it runs as. */
export function neevPrepareScript(): string {
  // Each step is timestamped in the log, for a slow or failed setup.
  const step = (name: string, command: string) => `echo "[$(date +%T)] ${name}"; ${command}`;
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    step("apt update", "apt-get update -q"),
    step("apt install", "apt-get install -y -q tmux git-lfs ripgrep jq"),
    step("claude code", "command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code"),
    step("user", `id -u ${BOX_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${BOX_USER}`),
    'echo "[$(date +%T)] done"',
  ].join("\n");
}

/** How long Neev keeps a paused box before deleting it, with any work on it
 *  that wasn't pushed. */
const PAUSED_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const PAUSING_WAIT_MS = 60_000;
const PAUSING_POLL_MS = 1_000;

export class NeevBackend implements SandboxBackend {
  private client: Neev | null = null;
  /** Neev's idle window on the box, in seconds: 0, none. */
  private readonly idleTimeoutSeconds: number;

  /** `idleBackstop`: Neev pauses the box if the reconciler stops renewing it. */
  constructor(options: { idleBackstop?: boolean } = {}) {
    this.idleTimeoutSeconds = options.idleBackstop ? IDLE_BACKSTOP_SECONDS : 0;
  }

  /** Renew the backstop, first arming it on a box made before it existed. */
  async keepAlive(id: string): Promise<void> {
    if (this.idleTimeoutSeconds === 0) return;
    const sandbox = await this.neev().sandboxes.get(id);
    if (sandbox.data.idle_timeout_seconds !== this.idleTimeoutSeconds) {
      await this.neev().sandboxes.updateTimeout(id, { idle_timeout_seconds: this.idleTimeoutSeconds, on_idle: "pause" });
    }
    await this.neev().sandboxes.keepalive(id);
  }

  /** Lazy so constructing the backend (e.g. in a test) needs no credentials. */
  private neev(): Neev {
    if (!this.client) {
      this.client = new Neev({
        apiKey: requireEnv("NEEV_API_KEY"),
        orgId: requireEnv("NEEV_ORG_ID"),
        projectId: requireEnv("NEEV_PROJECT_ID"),
        baseURL: optionalEnv("NEEV_BASE_URL"),
      });
    }
    return this.client;
  }

  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const sandbox = await this.neev().sandboxes.create({
      name: `outrunner-${labels["runtime.engine"] ?? "box"}-${randomUUID().slice(0, 8)}`,
      sandbox_template_id: optionalEnv("NEEV_SANDBOX_TEMPLATE") ?? DEFAULT_TEMPLATE,
      // Deny-all by default; the box clones from GitHub and Claude reaches its
      // model provider.
      allowInternet: true,
      // Outrunner pauses an idle box itself (lib/billing/reconcile.ts), by
      // what its sessions are doing. Neev's idle window is only a backstop the
      // reconciler renews, pausing (never deleting) a box it stops looking
      // at. A paused one is kept PAUSED_RETENTION_SECONDS, then deleted.
      lifecycle: {
        idle_timeout_seconds: this.idleTimeoutSeconds,
        max_lifetime_seconds: 0,
        paused_retention_seconds: PAUSED_RETENTION_SECONDS,
        ...(this.idleTimeoutSeconds > 0 && { on_idle: "pause" as const }),
      },
      // Otherwise the template's own (2 vCPU, 2 GB for the default).
      ...(size && { resources: neevResources(size) }),
    });
    try {
      await sandbox.waitUntilReady();
      const conn = await this.connection(sandbox.id);
      const runtime = new SandboxRuntime(conn);
      await prepare(runtime);
      return this.box(sandbox, runtime, conn);
    } catch (error) {
      await sandbox.delete().catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<SandboxBox> {
    const sandbox = await this.neev().sandboxes.get(id);
    const conn = await this.connection(id);
    return this.box(sandbox, new SandboxRuntime(conn), conn);
  }

  async alive(id: string): Promise<boolean> {
    try {
      return (await this.neev().sandboxes.get(id)).phase === "Ready";
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  async pause(id: string): Promise<void> {
    await this.neev().sandboxes.pause(id);
    closeNeevTunnels(id);
  }

  /** The paused box `id`, running again on the disk it kept. Null when Neev
   *  has deleted it, or it isn't paused but broken. */
  async restore(id: string): Promise<SandboxBox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.neev().sandboxes.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    // A pause still under way can't be resumed until it's done.
    for (let waited = 0; sandbox.phase === "Pausing" && waited < PAUSING_WAIT_MS; waited += PAUSING_POLL_MS) {
      await new Promise((r) => setTimeout(r, PAUSING_POLL_MS));
      await sandbox.refresh();
    }
    if (sandbox.phase !== "Paused" && sandbox.phase !== "Ready" && sandbox.phase !== "Pending") {
      // Not one Outrunner paused: crashed (NotReady), its state lost
      // (RestoreFailed), or unreadable. A new box, as before pausing existed,
      // rather than retrying one that won't come back.
      console.error(`Neev box ${id} is ${sandbox.phase}, not paused; starting a new one`);
      return null;
    }
    const resumed = sandbox.phase === "Paused";
    if (resumed) await sandbox.resume();
    try {
      await sandbox.waitUntilReady();
      const conn = await this.connection(id);
      return this.box(sandbox, new SandboxRuntime(conn), conn);
    } catch (error) {
      // Paused again rather than left running where nothing meters or pauses
      // it: its computer is saved stopped, which the reconciler doesn't check.
      if (resumed) await this.pause(id).catch((pauseError: unknown) => console.error(`Could not pause box ${id} again`, pauseError));
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.neev().sandboxes.delete(id);
    closeNeevTunnels(id);
  }

  /** How to reach one sandbox's runtime: its URL, on the project's API key. */
  private async connection(id: string): Promise<Connection> {
    const sandbox = await this.neev().sandboxes.get(id);
    const connectUrl = sandbox.connectUrl;
    if (!connectUrl) throw new Error(`Neev sandbox ${id} has no connect URL (phase ${sandbox.phase})`);
    return { connectUrl: connectUrl.replace(/\/$/, ""), apiKey: requireEnv("NEEV_API_KEY") };
  }

  private box(sandbox: Sandbox, runtime: SandboxRuntime, conn: Connection): SandboxBox {
    // Everything after setup runs as the box user, through a login shell so
    // HOME and PATH are its own. A secret rides in the exec's environment and
    // is let through by name (-w), never on a command line.
    const asUser = (command: string, env?: Record<string, string>) =>
      runtime.exec("runuser", asUserArgs(command, env), { env });
    const io: BoxIO = {
      exec: async (command) => {
        const res = await asUser(command);
        // Daytona's exec reports one combined stream; deploy reads stdout only.
        return { stdout: res.stdout + res.stderr, exitCode: res.exitCode };
      },
      // The launch script backgrounds the daemon itself, with its output sent
      // to a log, so the exec returns; setsid detaches it from this exec's
      // session in case the runtime reaps a finished command's group.
      launch: async (command) => {
        const res = await asUser(`setsid ${command} > /dev/null 2>&1 < /dev/null &`);
        if (res.exitCode !== 0) throw new Error(`Neev launch failed: ${tail(res.stderr)}`);
      },
      upload: async (data, remotePath) => {
        const staged = `${UPLOAD_DIR}/.upload-${randomUUID()}`;
        await runtime.write(staged, data);
        const moved = await runtime.exec("bash", [
          "-c",
          `install -D -o ${BOX_USER} -g ${BOX_USER} -m 644 ${shellQuote(staged)} ${shellQuote(remotePath)}; ` +
            `status=$?; rm -f ${shellQuote(staged)}; exit $status`,
        ]);
        if (moved.exitCode !== 0) {
          throw new Error(`Neev upload to ${remotePath} failed: ${tail(moved.stderr)}`);
        }
      },
    };
    const gitExec: GitExec = async (argv, options) => {
      const res = await asUser(argv.map(shellQuote).join(" "), options?.env);
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
    };
    return {
      id: sandbox.id,
      cpu: sandbox.resources?.cpu,
      io,
      gitExec,
      home: async () => BOX_HOME,
      // Control calls go through the tunnel from this server; the browser's
      // WebSockets come to this server's relay, which uses the same tunnel.
      agentEndpoint: async (port): Promise<AgentEndpoint> => ({
        controlBaseUrl: await neevTunnel(sandbox.id, port, conn.connectUrl),
        controlHeaders: {},
        wsBaseUrl: neevRelayBaseUrl(sandbox.id, port, conn.apiKey),
      }),
    };
  }
}

/** A size as Neev takes it. */
export function neevResources(size: BoxResources): { cpu: number; memory_gb: number } {
  return { cpu: size.cpu, memory_gb: size.memoryGb };
}

/** Where the browser opens a sandbox port's WebSockets: this server's relay,
 *  with a ticket for that port. */
export function neevRelayBaseUrl(sandboxId: string, port: number, apiKey: string): string {
  const origin = new URL(requireEnv("RUNTIME_BASE_URL")).origin.replace(/^http/, "ws");
  return `${origin}${NEEV_RELAY_PREFIX}${sandboxId}/${port}/${mintRelayTicket(sandboxId, port, apiKey)}`;
}

/**
 * Run the box setup in the background and wait for its exit status. Not one
 * long exec: installing takes about a minute with no output, and an idle
 * request that long is cut by the proxies in front of the sandbox (a held
 * exec hung for 16 minutes on a real box). Short polls instead.
 */
export async function prepare(
  runtime: Pick<SandboxRuntime, "exec">,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PREPARE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PREPARE_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const script = neevPrepareScript();
  const started = await runtime.exec("bash", [
    "-c",
    `rm -f ${PREPARE_EXIT}; ` +
      `setsid bash -c ${shellQuote(`bash -lc ${shellQuote(script)} > ${PREPARE_LOG} 2>&1; echo $? > ${PREPARE_EXIT}`)} ` +
      "< /dev/null > /dev/null 2>&1 &",
  ]);
  if (started.exitCode !== 0) throw new Error(`Neev box setup did not start: ${tail(started.stderr)}`);
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    const done = await runtime.exec("bash", ["-c", `cat ${PREPARE_EXIT} 2>/dev/null`]);
    const status = done.stdout.trim();
    if (status === "") continue;
    if (status === "0") return;
    const log = await runtime.exec("bash", ["-c", `tail -n 5 ${PREPARE_LOG} 2>/dev/null`]);
    throw new Error(`Neev box setup failed (exit ${status}): ${tail(log.stdout)}`);
  }
  throw new Error(`Neev box setup did not finish within ${Math.round(timeoutMs / 1000)} s`);
}

type Connection = { connectUrl: string; apiKey: string };

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/**
 * The calls this backend makes inside a sandbox, on the project's API key:
 * exec (newline-delimited JSON, base64 chunks, then an exit event) and a file
 * write.
 */
export class SandboxRuntime {
  private readonly conn: Connection;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  /** A refusal, with what to fix when it is the key's type. */
  private async refused(what: string, response: Response): Promise<Error> {
    const hint =
      response.status === 401
        ? " NEEV_API_KEY must be a project API key with Resource Type \"Sandboxes\" (sk-nc-…)."
        : "";
    return new Error(`Neev ${what} failed (HTTP ${response.status}): ${tail(await response.text())}${hint}`);
  }

  async exec(
    command: string,
    args: string[],
    options: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const response = await fetch(`${this.conn.connectUrl}/v1/exec`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.conn.apiKey}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        command,
        args,
        env: options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
        timeout_ms: options.timeoutMs,
      }),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs + 30_000) : undefined,
    });
    if (!response.ok) throw await this.refused("exec", response);
    return parseExecStream(await response.text());
  }

  async write(path: string, data: Buffer | Uint8Array): Promise<void> {
    const response = await fetch(
      `${this.conn.connectUrl}/v1/files/write?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.conn.apiKey}`,
          "content-type": "application/octet-stream",
        },
        // A Blob: fetch's types take no Buffer, and a copy keeps the bytes as is.
        body: new Blob([Uint8Array.from(data)]),
      },
    );
    if (!response.ok) throw await this.refused(`write ${path}`, response);
  }
}

/** Read exec's response: `{type:"stdout"|"stderr", data:<base64>}` chunks,
 *  then `{type:"exit", exit_code}`. A stream with no exit event failed. */
export function parseExecStream(body: string): ExecResult {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { type: string; data?: string; exit_code?: number };
    if (event.type === "stdout") stdout += Buffer.from(event.data ?? "", "base64").toString("utf8");
    else if (event.type === "stderr") stderr += Buffer.from(event.data ?? "", "base64").toString("utf8");
    else if (event.type === "exit") exitCode = event.exit_code ?? 0;
  }
  if (exitCode === null) throw new Error("Neev exec ended without an exit status");
  return { stdout, stderr, exitCode };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
}
