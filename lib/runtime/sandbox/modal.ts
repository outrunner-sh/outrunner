import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  InvalidError,
  ModalClient,
  NotFoundError,
  SnapshotCreationError,
  type Image,
  type Sandbox,
  type SandboxCreateParams,
} from "modal";

import { boxSize, DEFAULT_BOX_SIZE } from "@/lib/runtime/box-sizes";
import { AGENT_PORT, type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import {
  asUserArgs,
  BOX_USER,
  type AgentEndpoint,
  type BoxResources,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";

/**
 * Modal sandboxes, in a user's own Modal account on their token (Settings →
 * Sandbox).
 *
 * What differs from Daytona and Neev, all found on real sandboxes:
 *  - A sandbox lives a day at most: Modal ends it then. Each is made with an
 *    exit snapshot, so when it ends, for whatever reason, Modal keeps its disk
 *    as an image for 30 days, and {@link ModalBackend.restore} starts a new
 *    sandbox on it. The mirror, the worktrees and Claude's conversations are
 *    on that disk, so the sessions carry on; what was running (the agent,
 *    tmux, Claude) is started again.
 *  - The image is built in the user's account on first use, from node:22 with
 *    tmux, Claude Code and the user Claude runs as (a sandbox's own user is
 *    root), and Modal keeps it for the boxes after.
 *  - The agent is reached through the sandbox's tunnel, a public HTTPS URL for
 *    its port that takes WebSockets. The agent wants a token on every call but
 *    /health.
 */

/** The Modal App the sandboxes are made in, in the user's account. */
export const MODAL_APP = "outrunner";
/** As long as Modal lets a sandbox live. */
const LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A snapshot is taken as the sandbox ends; it can still be finishing. */
const SNAPSHOT_WAIT_MS = 120_000;
const BOX_HOME = `/home/${BOX_USER}`;

export const MODAL_BASE_IMAGE = "node:22-bookworm";
/** What the agent needs on top of node:22 (git and curl are in it). Claude
 *  Code is installed for the box user, so it can keep itself up to date. */
export const MODAL_IMAGE_SETUP = [
  "RUN apt-get update && apt-get install -y --no-install-recommends tmux git-lfs ripgrep jq " +
    "&& rm -rf /var/lib/apt/lists/*",
  `RUN useradd -m -s /bin/bash ${BOX_USER}`,
  `RUN su - ${BOX_USER} -c 'curl -fsSL https://claude.ai/install.sh | bash'`,
];

/** A Modal token: Settings → API Tokens in Modal. */
export type ModalToken = { tokenId: string; tokenSecret: string };

/** A sandbox's tunnel URL for a port, which lasts as long as the sandbox. */
const tunnels = new Map<string, string>();

/** One client per token: each holds a connection open to Modal. */
const clients = new Map<string, { secret: string; client: ModalClient }>();

function clientFor(token: ModalToken): ModalClient {
  const known = clients.get(token.tokenId);
  if (known?.secret === token.tokenSecret) return known.client;
  known?.client.close();
  const client = new ModalClient({ tokenId: token.tokenId, tokenSecret: token.tokenSecret });
  clients.set(token.tokenId, { secret: token.tokenSecret, client });
  return client;
}

/** How a box is made, new or restored. Without a size, Outrunner's default:
 *  Modal's own is an eighth of a CPU. */
export function sandboxParams(
  labels: Record<string, string>,
  size: BoxResources = boxSize(DEFAULT_BOX_SIZE),
): SandboxCreateParams {
  return {
    command: ["sleep", "infinity"],
    timeoutMs: LIFETIME_MS,
    encryptedPorts: [AGENT_PORT],
    tags: labels,
    cpu: size.cpu,
    memoryMiB: size.memoryGb * 1024,
    experimentalOptions: { enable_exit_snapshot: true },
  };
}

/** Whether a failure to get or boot from an ended box's snapshot means there
 *  is no disk to go on: the sandbox is gone, it never took one, or its
 *  snapshot failed or expired. */
export function noSnapshot(error: unknown): boolean {
  return (
    error instanceof NotFoundError || error instanceof InvalidError || error instanceof SnapshotCreationError
  );
}

export class ModalBackend implements SandboxBackend {
  private readonly token: () => Promise<ModalToken>;

  constructor(options: { token: () => Promise<ModalToken> }) {
    this.token = options.token;
  }

  private async modal(): Promise<ModalClient> {
    return clientFor(await this.token());
  }

  private async make(modal: ModalClient, image: Image, labels: Record<string, string>, size?: BoxResources) {
    const app = await modal.apps.fromName(MODAL_APP, { createIfMissing: true });
    return modal.sandboxes.create(app, image, sandboxParams(labels, size));
  }

  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const modal = await this.modal();
    const image = modal.images.fromRegistry(MODAL_BASE_IMAGE).dockerfileCommands(MODAL_IMAGE_SETUP);
    return box(await this.make(modal, image, labels, size));
  }

  async restore(id: string, labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox | null> {
    const modal = await this.modal();
    try {
      const ended = await modal.sandboxes.fromId(id);
      const disk = await ended.experimentalGetExitSnapshot({ timeoutMs: SNAPSHOT_WAIT_MS });
      return box(await this.make(modal, disk, labels, size));
    } catch (error) {
      if (noSnapshot(error)) return null;
      throw error;
    }
  }

  async get(id: string): Promise<SandboxBox> {
    return box(await (await this.modal()).sandboxes.fromId(id));
  }

  async alive(id: string): Promise<boolean> {
    try {
      // No exit code yet: still running.
      return (await (await (await this.modal()).sandboxes.fromId(id)).poll()) === null;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await (await (await this.modal()).sandboxes.fromId(id)).terminate();
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    for (const key of tunnels.keys()) if (key.startsWith(`${id}:`)) tunnels.delete(key);
  }
}

function box(sandbox: Sandbox): SandboxBox {
  const run = async (argv: string[], env?: Record<string, string>) => {
    const proc = await sandbox.exec(argv, { env });
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.readText(),
      proc.stderr.readText(),
      proc.wait(),
    ]);
    return { stdout, stderr, exitCode };
  };
  // Everything runs as the box user, through a login shell so HOME and PATH
  // are its own. A secret rides in the exec's environment and is let through
  // by name (-w), never on a command line.
  const asUser = (command: string, env?: Record<string, string>) =>
    run(["runuser", ...asUserArgs(command, env)], env);
  const io: BoxIO = {
    exec: async (command) => {
      const res = await asUser(command);
      // Daytona's exec reports one combined stream; deploy reads stdout only.
      return { stdout: res.stdout + res.stderr, exitCode: res.exitCode };
    },
    // The launch script backgrounds the daemon itself, with its output sent
    // to a log, so the exec returns; setsid takes it out of the exec's group.
    launch: async (command) => {
      const res = await asUser(`setsid ${command} > /dev/null 2>&1 < /dev/null &`);
      if (res.exitCode !== 0) throw new Error(`Modal launch failed: ${tail(res.stderr)}`);
    },
    // The SDK copies a local file in, as root; it is then the box user's.
    upload: async (data, remotePath) => {
      const local = await mkdtemp(path.join(os.tmpdir(), "outrunner-upload-"));
      const staged = `/tmp/.upload-${randomUUID()}`;
      try {
        await writeFile(path.join(local, "file"), data);
        await sandbox.filesystem.copyFromLocal(path.join(local, "file"), staged);
      } finally {
        await rm(local, { recursive: true, force: true });
      }
      const moved = await run([
        "bash",
        "-c",
        `install -D -o ${BOX_USER} -g ${BOX_USER} -m 644 ${shellQuote(staged)} ${shellQuote(remotePath)}; ` +
          `status=$?; rm -f ${shellQuote(staged)}; exit $status`,
      ]);
      if (moved.exitCode !== 0) throw new Error(`Modal upload to ${remotePath} failed: ${tail(moved.stderr)}`);
    },
  };
  const gitExec: GitExec = async (argv, options) => {
    const res = await asUser(argv.map(shellQuote).join(" "), options?.env);
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  };
  return {
    id: sandbox.sandboxId,
    io,
    gitExec,
    home: async () => BOX_HOME,
    // The tunnel is the agent's own port; the agent checks each call's token.
    agentEndpoint: async (port): Promise<AgentEndpoint> => {
      const key = `${sandbox.sandboxId}:${port}`;
      let url = tunnels.get(key);
      if (!url) {
        const tunnel = (await sandbox.tunnels())[port];
        if (!tunnel) throw new Error(`Modal sandbox ${sandbox.sandboxId} has no tunnel for port ${port}`);
        url = tunnel.url;
        tunnels.set(key, url);
      }
      return { controlBaseUrl: url, controlHeaders: {}, wsBaseUrl: url };
    },
  };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
}
