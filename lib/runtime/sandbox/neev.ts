import { randomUUID } from "node:crypto";

import { Neev, type Sandbox } from "@neevcloud/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import type { AgentEndpoint, SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";

/**
 * Neev sandboxes (NeevCloud Agent Sandboxes): NEEV_API_KEY, NEEV_ORG_ID,
 * NEEV_PROJECT_ID, optional NEEV_SANDBOX_TEMPLATE and NEEV_BASE_URL.
 *
 * What differs from Daytona, all found on real sandboxes:
 *  - Commands and file writes inside a sandbox (its `connect_url`) need a
 *    short-lived connect token minted from the API; the API key itself gets a
 *    401 there, and the SDK (0.8.2) sends the key. So this file talks to the
 *    sandbox directly ({@link SandboxRuntime}); the SDK does the rest.
 *  - The sandbox user is root, and Claude refuses bypassPermissions as root.
 *    Preparing the box creates a `runtime` user, and every command after that
 *    runs as it.
 *  - There is no usable sudo (no setuid), so the tools the agent needs (tmux,
 *    Claude Code) are installed here, as root, before the deploy runs.
 *  - Files can only be written under /workspace: an upload lands there and is
 *    moved into place.
 *  - A port's preview URL needs no credential: its random slug is the secret.
 */

const DEFAULT_TEMPLATE = "sb-ubuntu-26-04-dev";
/** The non-root user the agent and Claude run as. */
const BOX_USER = "runtime";
const BOX_HOME = `/home/${BOX_USER}`;
/** Uploads land here (the only writable tree), then move into place. */
const UPLOAD_DIR = "/workspace";
/** Connect tokens last 300 s; refresh well before. */
const TOKEN_REFRESH_MS = 240_000;
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

export class NeevBackend implements SandboxBackend {
  private client: Neev | null = null;

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

  async create(labels: Record<string, string>): Promise<SandboxBox> {
    const sandbox = await this.neev().sandboxes.create({
      name: `outrunner-${labels["runtime.engine"] ?? "box"}-${randomUUID().slice(0, 8)}`,
      sandbox_template_id: optionalEnv("NEEV_SANDBOX_TEMPLATE") ?? DEFAULT_TEMPLATE,
      // Deny-all by default; the box clones from GitHub and Claude reaches its
      // model provider.
      allowInternet: true,
      // Always-on, like every Runtime Computer: never paused or deleted idle.
      lifecycle: { idle_timeout_seconds: 0, max_lifetime_seconds: 0 },
    });
    try {
      await sandbox.waitUntilReady();
      const runtime = new SandboxRuntime(await this.connection(sandbox.id));
      await prepare(runtime);
      return this.box(sandbox, runtime);
    } catch (error) {
      await sandbox.delete().catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<SandboxBox> {
    const sandbox = await this.neev().sandboxes.get(id);
    return this.box(sandbox, new SandboxRuntime(await this.connection(id)));
  }

  async alive(id: string): Promise<boolean> {
    return (await this.neev().sandboxes.get(id)).phase === "Ready";
  }

  async delete(id: string): Promise<void> {
    await this.neev().sandboxes.delete(id);
  }

  /** How to reach one sandbox's runtime: its URL and a way to get a token. */
  private async connection(id: string): Promise<Connection> {
    const sandbox = await this.neev().sandboxes.get(id);
    const connectUrl = sandbox.connectUrl;
    if (!connectUrl) throw new Error(`Neev sandbox ${id} has no connect URL (phase ${sandbox.phase})`);
    const client = this.neev();
    const path =
      `/api/v1beta1/orgs/${encodeURIComponent(requireEnv("NEEV_ORG_ID"))}` +
      `/projects/${encodeURIComponent(requireEnv("NEEV_PROJECT_ID"))}` +
      `/sandboxes/${encodeURIComponent(id)}/connect-token`;
    return {
      connectUrl: connectUrl.replace(/\/$/, ""),
      mintToken: async () => {
        const body = await client.raw.request<{ token?: string }>({ method: "POST", path });
        if (!body?.token) throw new Error(`Neev returned no connect token for ${id}`);
        return body.token;
      },
    };
  }

  private box(sandbox: Sandbox, runtime: SandboxRuntime): SandboxBox {
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
      io,
      gitExec,
      home: async () => BOX_HOME,
      // The preview URL carries no credential (its slug is the secret), so the
      // same base serves control calls and the browser's WebSocket.
      agentEndpoint: async (port): Promise<AgentEndpoint> => {
        const url = (await sandbox.getUrl({ port, waitUntilReady: false })).replace(/\/$/, "");
        return { controlBaseUrl: url, controlHeaders: {}, wsBaseUrl: url };
      },
    };
  }
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

/** `runuser` arguments for `command` as the box user in a login shell. An env
 *  var is let through by name only; its value travels in the exec's
 *  environment, never in argv. */
export function asUserArgs(command: string, env?: Record<string, string>): string[] {
  const names = Object.keys(env ?? {});
  return ["-l", BOX_USER, ...(names.length > 0 ? ["-w", names.join(",")] : []), "-c", command];
}

type Connection = { connectUrl: string; mintToken: () => Promise<string> };

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/**
 * The calls this backend makes inside a sandbox, on a connect token: exec
 * (newline-delimited JSON, base64 chunks, then an exit event) and a file write.
 */
export class SandboxRuntime {
  private readonly conn: Connection;
  private token: string | null = null;
  private tokenAt = 0;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  private async bearer(): Promise<string> {
    if (!this.token || Date.now() - this.tokenAt > TOKEN_REFRESH_MS) {
      this.token = await this.conn.mintToken();
      this.tokenAt = Date.now();
    }
    return this.token;
  }

  async exec(
    command: string,
    args: string[],
    options: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const response = await fetch(`${this.conn.connectUrl}/v1/exec`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
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
    if (!response.ok) {
      throw new Error(`Neev exec failed (HTTP ${response.status}): ${tail(await response.text())}`);
    }
    return parseExecStream(await response.text());
  }

  async write(path: string, data: Buffer | Uint8Array): Promise<void> {
    const response = await fetch(
      `${this.conn.connectUrl}/v1/files/write?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.bearer()}`,
          "content-type": "application/octet-stream",
        },
        // A Blob: fetch's types take no Buffer, and a copy keeps the bytes as is.
        body: new Blob([Uint8Array.from(data)]),
      },
    );
    if (!response.ok) {
      throw new Error(`Neev write ${path} failed (HTTP ${response.status}): ${tail(await response.text())}`);
    }
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
