import { createHash, randomUUID } from "node:crypto";

import { Neev, NotFoundError, type Sandbox } from "@neevcloud/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { COMPUTER_ROLE, DEPLOYMENT_LABEL, deploymentName, type ListedBox, ROLE_LABEL } from "@/lib/runtime/orphan-boxes";
import { claudeInstallCommand } from "@/lib/runtime/claude-cli";
import { codexInstallCommand } from "@/lib/runtime/codex-cli";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import { ghInstallCommand } from "@/lib/runtime/github-cli";
import type { GitExec } from "@/lib/runtime/git";
import {
  asUserArgs,
  BOX_USER,
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

/** The template boxes are made from (NEEV_SANDBOX_TEMPLATE). */
export function neevTemplate(): string {
  return optionalEnv("NEEV_SANDBOX_TEMPLATE") ?? DEFAULT_TEMPLATE;
}

/** How long a golden snapshot lookup (or its absence) is trusted. */
const GOLDEN_CACHE_MS = 10 * 60_000;
/** How long a size whose golden snapshot Neev refused to restore is made
 *  from the template before the golden one is tried again. */
const GOLDEN_RETRY_MS = 2 * 60_000;

/** Prefix of Neev's golden boxes. It never matches neevBoxLabels' shape, so
 *  the orphaned-box sweep never lists, let alone deletes, one. */
export const GOLDEN_PREFIX = "outrunner-golden-";

/**
 * The version of what a golden box holds: a hash of the setup script (which
 * pins Claude Code, Codex and gh), the template, the disk and the home's
 * place. Any change makes a new version, and boxes ignore the old golden
 * boxes (made the slow way) until scripts/neev-golden.ts builds the new
 * ones; as Daytona's snapshot tag. The agent isn't in it: it's uploaded to
 * every box as it is provisioned.
 */
export function goldenVersion(): string {
  return createHash("sha256")
    .update(JSON.stringify({ script: neevPrepareScript(), template: neevTemplate(), disk: NEEV_DISK_GB, home: BOX_HOME }))
    .digest("hex")
    .slice(0, 8);
}

/** A size as a golden box's name has it: `2c4g`. */
export function goldenSizeKey(size: BoxResources): string {
  return `${size.cpu}c${size.memoryGb}g`.replace(/\./g, "p");
}

/** The golden box for `size` at this version: `outrunner-golden-2c4g-1a2b3c4d`. */
export function goldenName(size: BoxResources, version = goldenVersion()): string {
  return `${GOLDEN_PREFIX}${goldenSizeKey(size)}-${version}`;
}

/** The newest ready, restorable snapshot of the golden box `name`, or null
 *  where there's no such box or snapshot. */
export async function findGoldenSnapshot(neev: Neev, name: string): Promise<string | null> {
  const page = await neev.sandboxes.list({ name, limit: 10 });
  const golden = page.items.find((box) => box.name === name);
  if (!golden) return null;
  const snapshots = (await neev.sandboxes.listSnapshots(golden.id, { limit: 50 })).items
    .filter((snap) => snap.status === "Ready" && (snap as { restorability?: string }).restorability !== "unrestorable")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return snapshots[0]?.id ?? null;
}
/**
 * The box user's home, where the agent, the repository mirror, worktrees and
 * every dependency a session installs live: on /workspace, the box's data
 * disk. The root filesystem is small (4 GB for a 10 GB box, 3 GB of it free
 * once the tools are in), and grows little with the disk; /workspace gets the
 * rest, survives a pause like the root does, and doesn't count against the
 * box's memory (measured on real boxes, 2026-11-12). A box made before this
 * keeps its user's home in /home (home() reads it off the box).
 */
export const BOX_HOME = `/workspace/${BOX_USER}`;
/**
 * The disk every box is made with, in GB (Neev: multiples of 10, 10-100):
 * 6 GB for the root, 24 GB for /workspace, the home. Daytona's boxes have
 * 10 GB on one filesystem; a box's repository, its worktrees and their
 * node_modules need room past that.
 */
export const NEEV_DISK_GB = 30;
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
    step("claude code", claudeInstallCommand({ sudo: false })),
    step("codex", codexInstallCommand({ sudo: false })),
    step("github cli", ghInstallCommand({ sudo: false })),
    step("user", `id -u ${BOX_USER} >/dev/null 2>&1 || useradd -m -d ${BOX_HOME} -s /bin/bash ${BOX_USER}`),
    // Caches only, never what was installed: a smaller disk delta is a
    // smaller pause, resume and golden snapshot.
    step("clean", "apt-get clean; rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache"),
    'echo "[$(date +%T)] done"',
  ].join("\n");
}

/** How long Neev keeps a paused box before deleting it, with any work on it
 *  that wasn't pushed. */
const PAUSED_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/**
 * Seconds without activity before Neev pauses one of Outrunner's boxes on its
 * own (on_idle "pause": its disk is kept, and the next session resumes it):
 * the provider-side backstop should Outrunner stop looking after its boxes
 * (the reconciler's cron down, a deploy that broke it), so no box bills for
 * ever. As Daytona's (lib/runtime/sandbox/daytona.ts AUTO_STOP_MINUTES): the
 * reconciler heartbeats every box it looks at and keeps running
 * ({@link NeevBackend.keepAlive}), so a box in use is never paused by this
 * while the cron runs, whatever Neev counts as activity.
 */
export const IDLE_BACKSTOP_SECONDS = 4 * 60 * 60;
/** The lifecycle every box is made with, and a box made before it is given
 *  as it comes back (restore). */
export const NEEV_LIFECYCLE = {
  idle_timeout_seconds: IDLE_BACKSTOP_SECONDS,
  on_idle: "pause",
  max_lifetime_seconds: 0,
  paused_retention_seconds: PAUSED_RETENTION_SECONDS,
} as const;
/** How long a box Neev is bringing back (Pending, or restarting after a
 *  crash: NotReady) may take to be ready before it's given up on. */
const READY_TIMEOUT_MS = 180_000;
const PAUSING_WAIT_MS = 60_000;
const PAUSING_POLL_MS = 1_000;

export class NeevBackend implements SandboxBackend {
  private client: Neev | null = null;

  /** Lazy so constructing the backend (e.g. in a test) needs no credentials. */
  private neev(): Neev {
    if (!this.client) {
      this.client = new Neev({
        // Any key Neev's API takes: a personal access token still pauses,
        // heartbeats, lists and deletes boxes, so boxes already running stay
        // managed if one is set by mistake. Only reaching a box's runtime
        // needs a project key (runtimeKey).
        apiKey: requireEnv("NEEV_API_KEY"),
        orgId: requireEnv("NEEV_ORG_ID"),
        projectId: requireEnv("NEEV_PROJECT_ID"),
        baseURL: optionalEnv("NEEV_BASE_URL"),
      });
    }
    return this.client;
  }

  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    // Before Neev is asked: a box nothing can run on is never made.
    runtimeKey();
    const name = neevBoxName(labels);
    const sandbox = (await this.fromGolden(name, size)) ?? (await this.neev().sandboxes.create({
      name,
      sandbox_template_id: neevTemplate(),
      // Deny-all by default; the box clones from GitHub and Claude reaches its
      // model provider.
      allowInternet: true,
      // Outrunner pauses an idle box itself (lib/billing/reconcile.ts), by
      // what its sessions are doing; Neev's idle pause is only the backstop
      // (IDLE_BACKSTOP_SECONDS), and never deletes a box that isn't paused.
      // A paused one is kept PAUSED_RETENTION_SECONDS, then deleted.
      lifecycle: { ...NEEV_LIFECYCLE },
      // CPU and memory: otherwise the template's own (2 vCPU, 2 GB for the default).
      resources: { ...(size && neevResources(size)), disk_gb: NEEV_DISK_GB },
    }));
    try {
      await sandbox.waitUntilReady({ timeoutMs: READY_TIMEOUT_MS });
      const conn = this.connection(sandbox);
      const runtime = new SandboxRuntime(conn);
      // A golden box's restore has the tools and the user already; anything
      // else (or one that somehow lacks them) is set up here.
      if (!(await hasTools(runtime))) await prepare(runtime);
      return this.box(sandbox, runtime, conn);
    } catch (error) {
      await sandbox.delete().catch(() => {});
      throw error;
    }
  }

  /**
   * A new box restored from this version's golden snapshot for `size`
   * (scripts/neev-golden.ts), with the tools and the box user
   * already on it: about a third of the time of making one and setting it up.
   * Null when there's none (NEEV_BOX_SOURCE=create, no size, no golden box
   * for this version and size, or its snapshot isn't ready), or Neev
   * wouldn't restore it: the caller makes one from the template instead.
   */
  private async fromGolden(name: string, size?: BoxResources): Promise<Sandbox | null> {
    if (!size || optionalEnv("NEEV_BOX_SOURCE") === "create") return null;
    const snapshotId = await this.goldenSnapshot(size).catch((error: unknown) => {
      console.warn(`Could not look up Neev's golden snapshot for ${goldenSizeKey(size)}; making the box from the template`, error);
      return null;
    });
    if (!snapshotId) return null;
    try {
      console.info(`Neev box ${name}: restoring golden snapshot ${snapshotId} (${goldenSizeKey(size)})`);
      return await this.neev().sandboxes.create({
        name,
        restore: snapshotId,
        allowInternet: true,
        lifecycle: { ...NEEV_LIFECYCLE },
        // A restore must be the snapshot's own size, which is this size's.
        resources: { ...neevResources(size), disk_gb: NEEV_DISK_GB },
      } as Parameters<Neev["sandboxes"]["create"]>[0]);
    } catch (error) {
      // Gone since it was looked up (its golden box deleted takes it along),
      // or refused: the box is made the slow way, and the size is taken as
      // having none for a short while, so a snapshot Neev keeps refusing
      // doesn't cost every box a failed create; a passing blip, not long.
      this.goldens.set(goldenSizeKey(size), { snapshotId: null, until: Date.now() + GOLDEN_RETRY_MS });
      console.warn(`Neev wouldn't restore golden snapshot ${snapshotId}; making the box from the template`, error);
      return null;
    }
  }

  /** Golden snapshots by size, looked up at most every GOLDEN_CACHE_MS:
   *  each lookup is two Neev calls of about a second. */
  private readonly goldens = new Map<string, { snapshotId: string | null; until: number }>();

  private async goldenSnapshot(size: BoxResources): Promise<string | null> {
    const key = goldenSizeKey(size);
    const cached = this.goldens.get(key);
    if (cached && Date.now() < cached.until) return cached.snapshotId;
    const snapshotId = await findGoldenSnapshot(this.neev(), goldenName(size));
    this.goldens.set(key, { snapshotId, until: Date.now() + GOLDEN_CACHE_MS });
    return snapshotId;
  }

  async get(id: string): Promise<SandboxBox> {
    const sandbox = await this.neev().sandboxes.get(id);
    const conn = this.connection(sandbox);
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

  /** The reconciler's heartbeat: resets Neev's idle timer (IDLE_BACKSTOP_SECONDS). */
  async keepAlive(id: string): Promise<void> {
    await this.neev().sandboxes.keepalive(id);
  }

  /** The paused box `id`, running again on the disk it kept. Null when Neev
   *  has deleted it, or it is broken: its state lost (RestoreFailed), a crash
   *  it didn't come back from in time, or a restart that reset its storage. */
  async restore(id: string): Promise<SandboxBox | null> {
    // Before Neev is asked, as create() does: a paused box is never woken (and
    // billed), nor a pause waited out, only to fail at connection().
    runtimeKey();
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
    // Restarting after a crash (an OOM kill, a node lost): Neev brings it
    // back on its own, usually with its files, so it is waited for rather
    // than replaced, which left the session's work behind on it.
    // Still pausing past the wait: its disk is being saved, so a retry
    // resumes it; a new box now would leave the session's files behind.
    if (sandbox.phase === "Pausing") throw new Error(`Neev box ${id} is still pausing; try again in a minute`);
    const recovering = sandbox.phase === "NotReady" || sandbox.phase === "Unknown";
    if (sandbox.phase !== "Paused" && sandbox.phase !== "Ready" && sandbox.phase !== "Pending" && !recovering) {
      // Not one Outrunner paused: its state lost (RestoreFailed). A new box,
      // as before pausing existed, rather than retrying one that won't come
      // back.
      console.error(`Neev box ${id} is ${sandbox.phase}, not paused; starting a new one`);
      return null;
    }
    const resumed = sandbox.phase === "Paused";
    if (resumed) await sandbox.resume();
    try {
      try {
        await sandbox.waitUntilReady({ timeoutMs: READY_TIMEOUT_MS });
      } catch (error) {
        if (!recovering) throw error;
        console.error(`Neev box ${id} did not recover from ${sandbox.phase}; starting a new one`, error);
        // Paused, not left: no row will name it once the new box is up, so
        // should Neev bring it back later, nothing would meter or pause it
        // (and one made before the backstop has no idle limit). Its disk is
        // kept for the orphan sweep or an operator.
        await this.setAside(id);
        return null;
      }
      const conn = this.connection(sandbox);
      const runtime = new SandboxRuntime(conn);
      if (!(await prepared(runtime))) {
        // No box user: it can't host the sessions, so a new box is made in
        // its place. Deleted only when Neev itself says its storage was reset
        // (the files are gone either way); a probe that failed for another
        // reason, maybe a hiccup just after the resume, must never cost a
        // session its files, so that box is only paused, its disk kept for
        // the orphan sweep or an operator.
        const reset = sandbox.lastCrash?.storage_reset === true;
        console.error(
          `Neev box ${id} has no ${BOX_USER} user (last crash: ${JSON.stringify(sandbox.lastCrash)}); ` +
            `${reset ? "deleting it" : "pausing it"} and starting a new one`,
        );
        if (reset) await this.delete(id).catch((error: unknown) => console.error(`Could not delete Neev box ${id}`, error));
        else await this.setAside(id);
        return null;
      }
      // A box made before the backstop gets it as it comes back.
      await backstop(sandbox);
      return this.box(sandbox, runtime, conn);
    } catch (error) {
      // Paused again rather than left running where nothing meters or pauses
      // it: its computer is saved stopped, which the reconciler doesn't check.
      if (resumed) await this.pause(id).catch((pauseError: unknown) => console.error(`Could not pause box ${id} again`, pauseError));
      throw error;
    }
  }

  /** Pause a box restore gave up on, best effort: never left running with
   *  no row naming it. */
  private async setAside(id: string): Promise<void> {
    await this.pause(id).catch((error: unknown) => console.error(`Could not pause Neev box ${id}, given up on`, error));
  }

  async delete(id: string): Promise<void> {
    await this.neev().sandboxes.delete(id);
    closeNeevTunnels(id);
  }

  /**
   * The project's Outrunner boxes, as the orphaned-box sweep reads them
   * (lib/runtime/orphan-boxes.deps.ts): Neev has no labels, so a box's role,
   * engine and deployment are read off its name ({@link neevBoxName}). Neev
   * can't filter by age either; the sweep's own rules (sweepable) do. Its
   * last activity is when Neev last changed it (created, paused, resumed).
   */
  async *list(): AsyncIterable<ListedBox> {
    const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));
    for (let page = 1; ; page += 1) {
      const result = await this.neev().sandboxes.list({ page, limit: LIST_PAGE });
      for (const sandbox of result.items) {
        const labels = neevBoxLabels(sandbox.name, deployment);
        if (!labels) continue;
        yield {
          id: sandbox.id,
          labels,
          state: listedState(sandbox.phase),
          createdAt: sandbox.data.created_at,
          lastActivityAt: sandbox.data.updated_at,
        };
      }
      if (result.items.length < LIST_PAGE || page * LIST_PAGE >= result.total) return;
    }
  }

  /** How to reach one sandbox's runtime: its URL, on the project's API key.
   *  From the sandbox as just read, not read again: each Neev API call is
   *  about a second. */
  private connection(sandbox: Sandbox): Connection {
    const id = sandbox.id;
    const connectUrl = sandbox.connectUrl;
    if (!connectUrl) throw new Error(`Neev sandbox ${id} has no connect URL (phase ${sandbox.phase})`);
    return { connectUrl: connectUrl.replace(/\/$/, ""), apiKey: runtimeKey() };
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
      memoryGb: sandbox.resources?.memory_gb,
      io,
      gitExec,
      // Its user's own: /workspace/runtime, or /home/runtime on a box made
      // before homes moved to the data disk. From passwd, stdout only, as
      // root: io.exec mixes stderr in, and a login shell's profile can print.
      home: async () => {
        const res = await runtime.exec("getent", ["passwd", BOX_USER]);
        return (res.exitCode === 0 && res.stdout.split(":")[5]?.trim()) || BOX_HOME;
      },
      // Control calls go through the tunnel from this server; the browser's
      // WebSockets come to this server's relay, which uses the same tunnel.
      agentEndpoint: async (port): Promise<AgentEndpoint> => ({
        controlBaseUrl: await neevTunnel(sandbox.id, port, conn.connectUrl),
        controlHeaders: {},
        wsBaseUrl: neevRelayBaseUrl(sandbox.id, port, conn.apiKey),
      }),
      // The same tunnel reaches any port, straight to it: the server there
      // can be told the preview's own host.
      previewTarget: async (port) => ({
        baseUrl: await neevTunnel(sandbox.id, port, conn.connectUrl),
        headers: {},
        hostHeader: "preview",
      }),
    };
  }
}

/** Whether `key` is a personal access token (`pat-nc-…`): Neev's API takes
 *  one (create, list, pause), but a sandbox's runtime refuses it, so a box
 *  is made and then nothing can run on it. */
export function isNeevPersonalToken(key: string | undefined): boolean {
  return !!key && key.startsWith("pat-");
}

/** NEEV_API_KEY for a box's runtime (commands, uploads, the tunnel): refused
 *  up front when it's a personal access token, which the runtime answers
 *  with a 401, rather than after a box is made (and deleted) on every
 *  session. Neev's own API takes either. */
function runtimeKey(): string {
  const key = requireEnv("NEEV_API_KEY");
  if (isNeevPersonalToken(key)) {
    throw new Error(
      'NEEV_API_KEY is a personal access token (pat-nc-…); Neev sandboxes need a project API key with Resource Type "Sandboxes" (sk-nc-…).',
    );
  }
  return key;
}

/** Sandboxes per page when listing. */
const LIST_PAGE = 100;

/** Prefix of every box Outrunner makes on Neev: its role, as a label is on Daytona. */
const NAME_PREFIX = "outrunner-";

/** The deployment's tag in a box's name: its name hashed, short, as a DNS
 *  name allows (no dots, at most 63 characters in all). */
export function deploymentTag(deployment: string): string {
  return createHash("sha256").update(deployment).digest("hex").slice(0, 8);
}

/**
 * A new box's name, carrying what its labels would on Daytona: Outrunner's
 * prefix, its engine, the deployment that made it (tagged), and a random
 * part. `outrunner-claude-1a2b3c4d-9f8e7d6c`; one with no deployment, as
 * boxes were named before, `outrunner-claude-9f8e7d6c`.
 */
export function neevBoxName(labels: Record<string, string>): string {
  const engine = (labels["runtime.engine"] ?? "box").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "box";
  const deployment = labels[DEPLOYMENT_LABEL];
  return `${NAME_PREFIX}${engine}-${deployment ? `${deploymentTag(deployment)}-` : ""}${randomUUID().slice(0, 8)}`;
}

/**
 * A listed box's labels, read off its name: null for one that isn't
 * Outrunner's. One tagged with this deployment's name gets it as its
 * deployment label; another deployment's, a label that can't match; one from
 * before tags, none (unlabelled, which the sweep only ever holds on Neev).
 */
export function neevBoxLabels(name: string, deployment: string | null): Record<string, string> | null {
  const match = /^outrunner-([a-z0-9]+)-(?:([0-9a-f]{8})-)?([0-9a-f]{8})$/.exec(name);
  if (!match) return null;
  const [, engine, tag] = match;
  const labels: Record<string, string> = { [ROLE_LABEL]: COMPUTER_ROLE, "runtime.engine": engine };
  if (tag) labels[DEPLOYMENT_LABEL] = deployment && deploymentTag(deployment) === tag ? deployment : `neev-tag:${tag}`;
  return labels;
}

/** A Neev phase in the words the sweep's rules use (Daytona's states). */
function listedState(phase: string): string {
  switch (phase) {
    case "Ready":
      return "started";
    case "Paused":
      return "stopped";
    case "Pausing":
      return "pausing";
    case "Pending":
      return "starting";
    case "NotReady":
    case "RestoreFailed":
      return "error";
    default:
      return "unknown";
  }
}

/** Whether a box has everything prepare() installs, and its user: so a
 *  golden box's restore needn't run it again. */
export async function hasTools(runtime: Pick<SandboxRuntime, "exec">): Promise<boolean> {
  const check = `id -u ${BOX_USER} >/dev/null && command -v tmux git-lfs rg jq claude codex gh >/dev/null`;
  return (await runtime.exec("bash", ["-lc", check])).exitCode === 0;
}

/** Whether a box still has what prepare() gave it (its user): false after a
 *  restart that reset its storage. */
async function prepared(runtime: Pick<SandboxRuntime, "exec">): Promise<boolean> {
  return (await runtime.exec("id", ["-u", BOX_USER])).exitCode === 0;
}

/** Give a box made before it the idle backstop (NEEV_LIFECYCLE). Best
 *  effort: the box is up either way, and the reconciler still looks after it. */
export async function backstop(sandbox: Pick<Sandbox, "id" | "data" | "updateTimeout">): Promise<void> {
  if (sandbox.data.idle_timeout_seconds === IDLE_BACKSTOP_SECONDS && sandbox.data.on_idle === "pause") return;
  await Promise.resolve()
    .then(() => sandbox.updateTimeout({ idle_timeout_seconds: IDLE_BACKSTOP_SECONDS, on_idle: "pause" }))
    .catch((error: unknown) => console.warn(`Could not set Neev box ${sandbox.id}'s idle backstop`, error));
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
      // The command's own limit, or Daytona's (EXEC_TIMEOUT_SECONDS) when it
      // has none, and a margin for the stream: never a request held for good.
      signal: AbortSignal.timeout((options.timeoutMs ?? NEEV_EXEC_DEFAULT_TIMEOUT_MS) + 30_000),
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
        signal: AbortSignal.timeout(NEEV_WRITE_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw await this.refused(`write ${path}`, response);
  }
}

/** An exec with no timeout of its own waits this long, as Daytona's does. */
const NEEV_EXEC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** A file write (the agent's binary is the largest) waits this long. */
const NEEV_WRITE_TIMEOUT_MS = 2 * 60 * 1000;

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
