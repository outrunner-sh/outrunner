import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RESOURCE_PROBE, resourceReading, type ComputerReading } from "@/lib/session/session-info";
import { optionalEnv } from "@/lib/env";
import { growMemoryUnderPressure, type MemoryScaleResult } from "@/lib/runtime/memory-scaling";
import { gitCredentialEnvironment } from "@/lib/runtime/git-credential";
import type { AgentTarget } from "@/lib/runtime/agent-client";
import { AgentEndpointCache } from "@/lib/runtime/agent-endpoint-cache";
import { ATTACHMENT_DIR } from "@/lib/runtime/attachments";
import {
  BOX_IMAGE_MAX_BYTES,
  IMAGE_MISSING,
  IMAGE_TOO_LARGE,
  imageBase64,
  imageReadCommand,
} from "@/lib/runtime/chat-image";
import {
  AGENT_PORT,
  deployClaude,
  deployJcode,
  ProvisionTimer,
  shellQuote,
} from "@/lib/runtime/daytona/deploy";
import {
  cloneMirror,
  commitAll,
  fetchMirror,
  syncMirrors,
  type GitTokenFor,
  listChangedFiles,
  pushBranch,
  readFileDiff,
} from "@/lib/runtime/git";
import { boxLabels, deploymentName } from "@/lib/runtime/orphan-boxes";
import type { BoxResources, BrowserLink, PreviewTarget, SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";
import type {
  ChangedFile,
  CommitWorkspaceResult,
  CreatePullRequestResult,
  CreateWorkspaceResult,
  ProviderName,
  ProvisionStage,
  ProvisionTimings,
  RuntimeProvider,
} from "@/lib/runtime/types";

/**
 * Read the jcode subscription credential the control plane injects into each
 * box.
 *
 * Two sources, in priority order:
 *  1. Inline base64 env vars `JCODE_AUTH_JSON` (+ optional
 *     `JCODE_AUTH_REFRESH_JSON`) — for a hosted control plane (e.g. Railway)
 *     that has no `~/.jcode` on disk. Each is the base64 of the corresponding
 *     jcode file.
 *  2. The operator's `~/.jcode` directory (where `jcode login` stored it),
 *     overridable with `JCODE_AUTH_DIR` — the local-dev path.
 *
 * Throws a clear error if neither is present.
 */
/**
 * Decode a base64 jcode credential from an env var, failing loudly on bad input.
 *
 * `Buffer.from(_, "base64")` is lenient: it silently drops invalid characters
 * and stops at the first padding, so a truncated or corrupted paste decodes to
 * garbage that we'd upload as `auth.json` — surfacing only much later as an
 * opaque authentication error on the box. We reject anything that doesn't
 * round-trip as clean base64, and — since both jcode credential files are JSON —
 * anything that doesn't decode to parseable JSON. Whitespace/newlines in the env
 * value are tolerated (a wrapped base64 paste is still valid).
 */
export function decodeBase64Credential(name: string, value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(
      `${name} is not valid base64. Re-encode the file with \`base64 < <file>\`.`,
    );
  }
  try {
    JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error(
      `${name} did not decode to valid JSON — the base64 is likely truncated or ` +
        `not the credential file.`,
    );
  }
  return decoded;
}

function readJcodeCreds(): { authJson: Buffer; refreshJson?: Buffer } {
  const inlineAuth = optionalEnv("JCODE_AUTH_JSON");
  if (inlineAuth) {
    const inlineRefresh = optionalEnv("JCODE_AUTH_REFRESH_JSON");
    return {
      authJson: decodeBase64Credential("JCODE_AUTH_JSON", inlineAuth),
      refreshJson: inlineRefresh
        ? decodeBase64Credential("JCODE_AUTH_REFRESH_JSON", inlineRefresh)
        : undefined,
    };
  }

  const dir = optionalEnv("JCODE_AUTH_DIR") ?? path.join(os.homedir(), ".jcode");
  const authPath = path.join(dir, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(
      `jcode credential not found. Set JCODE_AUTH_JSON (base64 of auth.json) for a ` +
        `hosted deploy, or run \`jcode login --provider claude\` / set JCODE_AUTH_DIR ` +
        `to the directory holding auth.json (looked in ${authPath}).`,
    );
  }
  const refreshPath = path.join(dir, "auth-refresh-state.json");
  return {
    authJson: readFileSync(authPath),
    refreshJson: existsSync(refreshPath) ? readFileSync(refreshPath) : undefined,
  };
}

const DEFAULT_BINARY_PATH = ".context/build/runtime-agent-linux-amd64";

/** Everything the control plane needs to reach a freshly provisioned box. */
export type ProvisionedComputer = {
  sandboxId: string;
  /** Base URL for control calls to the agent. The full endpoint (headers, the
   *  browser's WebSocket URL) comes from {@link ComputerRuntimeProvider.agentTarget},
   *  fetched fresh each time since it may be short-lived. */
  agentBaseUrl: string;
  timings: ProvisionTimings;
  /** The box's vCPUs, where the provider says (SandboxBox.cpu). */
  cpu?: number;
};

export type ProvisionComputerInput = {
  /** Per-computer secret (runtime_computers.agent_secret) the agent verifies. */
  secret: string;
  /** When set, seed the bare mirror so worktrees can be created immediately. */
  repoFullName?: string;
  githubToken?: string;
  /** Project secrets delivered into the agent's memory at launch and injected
   *  into each Claude session's env (e.g. CLAUDE_CODE_OAUTH_TOKEN). Never at
   *  rest on the box — in-memory only, not written to disk or archived.
   *  TODO(M3): replace launch-time env injection with runtime-agent secret
   *  provisioning (a dedicated delivery channel), so per-workspace secrets don't
   *  ride the boot env. */
  sessionEnv?: Record<string, string>;
  /** CPU and memory for the new box, where the backend can size one. */
  size?: BoxResources;
  /**
   * The project's box before this one, which ended on its own. A backend that
   * keeps an ended box's disk ({@link SandboxBackend.restore}, Modal) starts
   * the new box on it, so the sessions on it carry on, and the mirror is
   * already there. Otherwise, or with that disk gone, the box is a new one.
   */
  previousSandboxId?: string;
  /** Optional live per-stage progress (the UI/verify script logs these). */
  onStage?: (stage: ProvisionStage, ms: number) => void;
  /** Told the box's id as soon as there is one, before the agent and the
   *  repository: so a caller cut off mid-provision (the warm pool) has it on
   *  record, and can delete the box rather than leave it running unknown. */
  onBox?: (sandboxId: string) => Promise<void>;
};

/**
 * Runtime's real compute model: one always-on box per Project (the Runtime
 * Computer), with workspaces living inside it as tmux sessions/worktrees, on
 * whichever sandbox provider a {@link SandboxBackend} wraps. This is NOT
 * Modal's workspace-per-sandbox shape, so the class is deliberately split:
 *
 *  - The honest, tested surface is the **Runtime Computer lifecycle**:
 *    {@link provisionComputer} (create box + deploy agent + seed mirror, all
 *    timed), {@link computerAlive}, {@link destroyComputer}, {@link agentTarget}.
 *    Workspace/session operations run through {@link AgentClient}, not here.
 *
 *  - The workspace-centric {@link RuntimeProvider} methods below are the Modal
 *    shape. The batch/SSE ones are **retired** (M2 pt3 deletes them); the rest
 *    are driven through the agent and are wired at the route layer, not the
 *    provider. Both throw a clear error rather than pretend to work.
 *
 * The `RuntimeProvider` implementation exists only so provider selection
 * (`provider.ts`/`resolve.ts`) type-checks during the transition.
 */
/** Agent upgrades under way (ComputerRuntimeProvider.upgradeAgent), by
 *  provider and box, across every provider instance in this server. */
const UPGRADING = new Map<string, Promise<void>>();

/** Each box's agent endpoint, by provider and box, across every provider
 *  instance in this server (a route makes a new provider per request). */
const AGENT_ENDPOINTS = new AgentEndpointCache();

export class ComputerRuntimeProvider implements RuntimeProvider {
  readonly name: ProviderName;
  private readonly backend: SandboxBackend;
  private agentBinary: Buffer | null = null;

  // Plain fields, not parameter properties: Node's strip-only TypeScript (the
  // test runner) can't run those.
  constructor(name: ProviderName, backend: SandboxBackend) {
    this.name = name;
    this.backend = backend;
  }

  /** Read (and cache) the cross-compiled agent uploaded on each provision. */
  private async binary(): Promise<Buffer> {
    if (!this.agentBinary) {
      const configured = optionalEnv("RUNTIME_AGENT_BINARY_PATH");
      const binaryPath = configured
        ? path.resolve(configured)
        : path.resolve(process.cwd(), DEFAULT_BINARY_PATH);
      try {
        this.agentBinary = await readFile(binaryPath);
      } catch (error) {
        throw new Error(
          `Cannot read runtime-agent binary at ${binaryPath}. Cross-compile it ` +
            `(GOOS=linux GOARCH=amd64 …) or set RUNTIME_AGENT_BINARY_PATH. Cause: ${
              (error as Error).message
            }`,
        );
      }
    }
    return this.agentBinary;
  }

  // --- Runtime Computer lifecycle (the honest surface) ----------------------

  /**
   * Provision the always-on box and deploy the agent, then optionally seed the
   * bare mirror. Delegates by engine: RUNTIME_ENGINE=jcode takes the jcode path;
   * otherwise the default Claude engine (provisionClaudeComputer). Each path
   * times its stages and deletes the half-built sandbox on failure so a retry
   * starts clean.
   */
  async provisionComputer(
    input: ProvisionComputerInput,
  ): Promise<ProvisionedComputer> {
    if (optionalEnv("RUNTIME_ENGINE") === "jcode") {
      return this.provisionJcodeComputer(input);
    }
    return this.provisionClaudeComputer(input);
  }

  /**
   * Claude Code engine provisioning on the backend's base image, which ships
   * the `claude` CLI + node; deployClaude only adds tmux and boots the agent in
   * Claude mode rooted at $HOME, seeding CLAUDE_CODE_OAUTH_TOKEN so each Claude
   * session authenticates. No jcode, no snapshot, no subscription-refresh trap.
   */
  private async provisionClaudeComputer(
    input: ProvisionComputerInput,
  ): Promise<ProvisionedComputer> {
    const binary = await this.binary();
    const timer = new ProvisionTimer({
      onStage: (t) => input.onStage?.(t.stage, t.ms),
    });

    // Its role and deployment are what the orphaned-box sweep goes by
    // (lib/runtime/orphan-boxes.ts).
    const labels = boxLabels("claude", deploymentName(optionalEnv("RUNTIME_BASE_URL")));
    let sandbox: SandboxBox | null = null;
    try {
      sandbox = await this.restoreBox(timer, labels, input);
      const restored = sandbox !== null;
      sandbox ??= await timer.stage("sandbox_create", () => this.backend.create(labels, input.size));
      await input.onBox?.(sandbox.id);
      const box = sandbox;
      const home = await box.home();

      const boot = () => timer.stage("agent_boot", () =>
        deployClaude(box.io, binary, input.secret, {
          root: home,
          sessionEnv: boxEnvironment(box.id, input.sessionEnv, !!box.growMemory),
        }),
      );
      if (restored) {
        // Preserve restored CLI/auth ordering and its only copy of the work.
        await boot();
        await timer
          .stage("mirror_fetch", () =>
            fetchMirror(box.gitExec, { repoDir: `${home}/repo.git`, token: input.githubToken }),
          )
          .catch((error: unknown) => console.warn(`Could not fetch the mirror on restored box ${box.id}`, error));
      } else {
        // A bare mirror only needs the base image's git. It writes repo.git;
        // installing/booting the agent writes other paths and needn't precede
        // it. Wait for BOTH before cleanup if either fails, so no still-running
        // upload or clone is left racing deletion of a failed new box.
        const tasks: Promise<unknown>[] = [boot()];
        if (input.repoFullName) tasks.push(timer.stage("mirror_clone", () =>
          cloneMirror(box.gitExec, { repoFullName: input.repoFullName!, dir: `${home}/repo.git`, token: input.githubToken }),
        ));
        const results = await Promise.allSettled(tasks);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }

      const endpoint = await box.agentEndpoint(AGENT_PORT);
      return { sandboxId: box.id, agentBaseUrl: endpoint.controlBaseUrl, timings: timer.timings(), cpu: box.cpu };
    } catch (error) {
      if (sandbox) await this.discardFailedBox(sandbox.id, input.previousSandboxId);
      throw error;
    }
  }

  /**
   * A box that didn't come up goes: deleted when it is a new one (on Modal, a
   * restore is a new box too, and the ended one is kept). A paused box
   * resumed in place is the only copy of its sessions, so it is paused again,
   * for the next try to resume, never deleted.
   */
  private async discardFailedBox(id: string, previousSandboxId: string | undefined): Promise<void> {
    if (id === previousSandboxId) {
      await this.backend
        .pause?.(id)
        .catch((pauseError: unknown) => console.error(`Could not pause box ${id} again after it failed to come up`, pauseError));
      return;
    }
    await this.backend
      .delete(id)
      .catch((cleanupError: unknown) => console.error("Could not delete failed Claude computer", cleanupError));
  }

  /** Whether this provider's boxes end on their own and come back on the
   *  disk they left (Modal), so a box that ended is worth restoring. */
  get restoresBoxes(): boolean {
    return this.backend.restore !== undefined;
  }

  /** The new box on the disk `input.previousSandboxId` left, when the backend
   *  keeps one; null to make a new box instead. */
  private async restoreBox(
    timer: ProvisionTimer,
    labels: Record<string, string>,
    input: ProvisionComputerInput,
  ): Promise<SandboxBox | null> {
    const previous = input.previousSandboxId;
    if (!previous || !this.backend.restore) return null;
    // A paused box comes back as the same one, maybe reached somewhere new.
    this.forgetEndpoint(previous);
    const restore = this.backend.restore.bind(this.backend);
    return timer.stage("sandbox_restore", () => restore(previous, labels, input.size));
  }

  /**
   * jcode-engine provisioning on the backend's base image, with jcode installed
   * on-provision, the subscription credential injected, the api-bridge started,
   * and the agent launched in jcode mode. The recipe (incl. the USER/XDG/pinned
   * -socket fix) lives in deployJcode; validated on real Daytona.
   */
  private async provisionJcodeComputer(
    input: ProvisionComputerInput,
  ): Promise<ProvisionedComputer> {
    const binary = await this.binary();
    const creds = readJcodeCreds();
    const timer = new ProvisionTimer({
      onStage: (t) => input.onStage?.(t.stage, t.ms),
    });

    let sandbox: SandboxBox | null = null;
    try {
      // Always-on retention (every backend's create): the box + its disk
      // (worktrees, jcode sessions, conversation logs) stay live, so
      // reconnect/resume just works with no wake path.
      sandbox = await timer.stage("sandbox_create", () =>
        this.backend.create(boxLabels("jcode", deploymentName(optionalEnv("RUNTIME_BASE_URL"))), input.size),
      );
      const box = sandbox;
      const home = await box.home();

      await timer.stage("agent_boot", () =>
        deployJcode(box.io, binary, input.secret, {
          root: home,
          authJson: creds.authJson,
          refreshJson: creds.refreshJson,
        }),
      );

      if (input.repoFullName) {
        await timer.stage("mirror_clone", () =>
          cloneMirror(box.gitExec, {
            repoFullName: input.repoFullName!,
            // Agent RUNTIME_AGENT_ROOT=home, so its mirror is $HOME/repo.git.
            dir: `${home}/repo.git`,
            token: input.githubToken,
          }),
        );
      }

      const endpoint = await box.agentEndpoint(AGENT_PORT);
      return { sandboxId: box.id, agentBaseUrl: endpoint.controlBaseUrl, timings: timer.timings() };
    } catch (error) {
      if (sandbox) {
        await this.backend
          .delete(sandbox.id)
          .catch((cleanupError: unknown) =>
            console.error("Could not delete failed jcode computer", cleanupError),
          );
      }
      throw error;
    }
  }

  /** Refresh the shared mirror before creating a new worktree. Both engines
   *  clone it to $HOME/repo.git, so it is found from the box's home. */
  async fetchMirror(sandboxId: string, githubToken?: string): Promise<void> {
    const box = await this.backend.get(sandboxId);
    await fetchMirror(box.gitExec, {
      repoDir: `${await box.home()}/repo.git`,
      token: githubToken,
    });
  }

  /** A mirror of each repository of a multi-repository session, at
   *  $HOME/repos/<checkout>.git where the agent finds them (its
   *  RepoMirrorPath): fetched where the box has one, cloned where not. Each
   *  with its own token where they differ (the App's are per repository). */
  async syncRepoMirrors(
    sandboxId: string,
    repos: { fullName: string; checkout: string }[],
    githubToken?: string | GitTokenFor,
  ): Promise<void> {
    const box = await this.backend.get(sandboxId);
    const home = await box.home();
    await box.gitExec(["mkdir", "-p", `${home}/repos`]);
    // One at a time, each in the log as it's done, so a session stopped among
    // them shows which repository it was at.
    for (const repo of repos) {
      const began = Date.now();
      console.log(`Box ${sandboxId}: syncing ${repo.fullName}'s mirror`);
      await syncMirrors(box.gitExec, { root: `${home}/repos`, repos: [repo], token: githubToken });
      console.log(`Box ${sandboxId}: ${repo.fullName}'s mirror synced (${Math.round((Date.now() - began) / 1000)}s)`);
    }
  }

  /** Git projection for one interactive worktree on the shared computer: its
   *  changes since `baseBranch`, or only the uncommitted ones without it. */
  async listWorkspaceChangedFiles(
    sandboxId: string,
    worktreePath: string,
    baseBranch?: string,
  ): Promise<ChangedFile[]> {
    const box = await this.backend.get(sandboxId);
    return listChangedFiles(box.gitExec, { worktree: worktreePath, baseBranch });
  }

  /** Bounded diff for one changed path in an interactive worktree. */
  async readWorkspaceChangedFileDiff(
    sandboxId: string,
    worktreePath: string,
    filePath: string,
    baseBranch?: string,
  ): Promise<string> {
    const box = await this.backend.get(sandboxId);
    return readFileDiff(box.gitExec, {
      worktree: worktreePath,
      path: filePath,
      baseBranch,
    });
  }

  /** Commit all current changes in a Runtime worktree. */
  async commitWorkspaceChanges(
    sandboxId: string,
    worktreePath: string,
    input: { message: string; author: { name: string; email: string } },
  ): Promise<CommitWorkspaceResult> {
    const box = await this.backend.get(sandboxId);
    return commitAll(box.gitExec, { worktree: worktreePath, ...input });
  }

  /**
   * Write composer attachments into a worktree's `.attachments/` directory.
   *
   * Claude's working directory is the worktree, so the prompt can then refer to
   * them by relative path and Claude opens them with its own tools. Names are
   * already sanitized and de-duplicated by lib/runtime/attachments.ts — this
   * method must not be handed a raw user filename.
   */
  async writeWorkspaceAttachments(
    sandboxId: string,
    worktreePath: string,
    files: Array<{ filename: string; bytes: Buffer }>,
  ): Promise<void> {
    if (files.length === 0) return;
    const box = await this.backend.get(sandboxId);
    const dir = `${worktreePath}/${ATTACHMENT_DIR}`;
    // mkdir -p first: an upload need not create intermediate directories, and
    // a fresh worktree has no .attachments/.
    await box.io.exec(`mkdir -p ${shellQuote(dir)}`);
    // A .gitignore of "*" inside ignores the folder, itself included, so a
    // pasted screenshot never lands in a commit or a PR (the agent does the
    // same for .context). Every time: it costs one small upload, and a
    // folder from before this has none. Names here are never dotfiles.
    await Promise.all([
      box.io.upload(Buffer.from("*\n"), `${dir}/.gitignore`),
      ...files.map((file) => box.io.upload(file.bytes, `${dir}/${file.filename}`)),
    ]);
  }

  /** Write a file at `relPath` in a worktree (its folder made as needed):
   *  for a Mission's notes, kept on its box as they're saved
   *  (lib/missions/store.ts). The path is the caller's, never a user's. */
  async writeWorkspaceFile(
    sandboxId: string,
    worktreePath: string,
    relPath: string,
    bytes: Buffer,
    { ifMissing = false }: { ifMissing?: boolean } = {},
  ): Promise<boolean> {
    const box = await this.backend.get(sandboxId);
    const path = `${worktreePath}/${relPath}`;
    // Only where there's none: one there may hold edits not saved yet.
    if (ifMissing && (await box.io.exec(`test -e ${shellQuote(path)}`)).exitCode === 0) return false;
    await box.io.exec(`mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf("/")))}`);
    await box.io.upload(bytes, path);
    return true;
  }

  /** The file at `path` on the box (absolute), for the chat to show as an
   *  image: its bytes, or why not. Its type is the caller's to check. */
  async readBoxImage(sandboxId: string, path: string): Promise<Buffer | "missing" | "too-large"> {
    const box = await this.backend.get(sandboxId);
    const { stdout, exitCode } = await box.io.exec(imageReadCommand(path));
    if (exitCode === IMAGE_MISSING) return "missing";
    if (exitCode === IMAGE_TOO_LARGE) return "too-large";
    if (exitCode !== 0) throw new Error(`Reading ${path} off the box exited ${exitCode}`);
    const base64 = imageBase64(stdout);
    if (base64 === null) throw new Error(`Reading ${path} off the box printed no image`);
    const bytes = Buffer.from(base64, "base64");
    // It grew past the cap between being measured and read.
    return bytes.length > BOX_IMAGE_MAX_BYTES ? "too-large" : bytes;
  }

  /** Push an interactive worktree's persisted branch with a request-scoped token. */
  async pushWorkspaceChanges(
    sandboxId: string,
    worktreePath: string,
    input: { repoFullName: string; branch: string; githubToken: string },
  ): Promise<void> {
    const box = await this.backend.get(sandboxId);
    await pushBranch(box.gitExec, {
      worktree: worktreePath,
      repoFullName: input.repoFullName,
      branch: input.branch,
      token: input.githubToken,
    });
  }

  /** Whether the box is still up and able to host sessions. */
  async computerAlive(sandboxId: string): Promise<boolean> {
    if (!sandboxId) return false;
    try {
      return await this.backend.alive(sandboxId);
    } catch (error) {
      console.error(`Could not read ${this.name} computer ${sandboxId}`, error);
      return false;
    }
  }

  /** Whether the box is running: unlike {@link computerAlive}, a provider
   *  that can't be asked is a throw, not "gone", so a hiccup isn't taken for
   *  a lost box. */
  async computerRunning(sandboxId: string): Promise<boolean> {
    return this.backend.alive(sandboxId);
  }

  /** Whether this provider can pause a box and bring it back. Not for the
   *  jcode engine, whose provision always makes a new box: a paused one would
   *  be left behind with its sessions. */
  get pausesBoxes(): boolean {
    return (
      this.backend.pause !== undefined &&
      this.backend.restore !== undefined &&
      optionalEnv("RUNTIME_ENGINE") !== "jcode"
    );
  }

  /** Inspect an already-running computer. Neither alive/get nor the fixed probe
   * starts, restores, attaches to or upgrades a box. */
  async inspectComputer(sandboxId: string): Promise<ComputerReading | null> {
    if (!await this.backend.alive(sandboxId)) return null;
    const box = await this.backend.get(sandboxId);
    const result = await box.io.exec(RESOURCE_PROBE).catch(() => null);
    return resourceReading(result?.exitCode === 0 ? result.stdout : "", box.cpu, box.memoryGb);
  }

  /** The box's vCPUs, where the provider says. */
  async computerCpu(sandboxId: string): Promise<number | undefined> {
    return (await this.backend.get(sandboxId)).cpu;
  }

  /** Only inspect a running box; autoscaling never resumes an idle one. */
  async scaleComputerMemory(sandboxId: string, maxMemoryGb: number, resizeBefore?: number): Promise<MemoryScaleResult> {
    if (!await this.backend.alive(sandboxId)) return { outcome: "unavailable" };
    return growMemoryUnderPressure(await this.backend.get(sandboxId), maxMemoryGb, resizeBefore);
  }

  /** Pause the box, keeping its disk for the next session to resume. */
  async pauseComputer(sandboxId: string): Promise<void> {
    if (!this.backend.pause) throw new Error(`${this.name} can't pause a box`);
    this.forgetEndpoint(sandboxId);
    await this.backend.pause(sandboxId);
  }

  /** Tear the box down (destroys all worktrees/sessions inside it). */
  async destroyComputer(sandboxId: string): Promise<void> {
    if (!sandboxId) return;
    this.forgetEndpoint(sandboxId);
    try {
      await this.backend.delete(sandboxId);
    } catch (error) {
      // Already gone is success from the caller's perspective.
      console.error(`Could not delete ${this.name} computer ${sandboxId}`, error);
    }
  }

  /** Tear the box down, or throw: for a caller that must know the box is gone
   *  before it stops metering it and forgets it. One already gone is gone. */
  async destroyComputerOrThrow(sandboxId: string): Promise<void> {
    this.forgetEndpoint(sandboxId);
    try {
      await this.backend.delete(sandboxId);
    } catch (error) {
      if (!boxGone(error)) throw error;
    }
  }

  /** Whether a box's agent can be upgraded in place (upgradeAgent): not on
   *  the jcode engine, whose boxes are replaced, not redeployed. */
  get upgradesAgents(): boolean {
    return optionalEnv("RUNTIME_ENGINE") !== "jcode";
  }

  /**
   * Bring a running box's agent up to this release's, in place: the tools it
   * runs (Codex among them) installed, the agent replaced and restarted on
   * the same secret and port. A box's sessions run in tmux, not in the agent,
   * so they carry on through it; their streams reconnect. For a box that
   * predates what a session needs, instead of waiting for it to pause and
   * restart. Not for the jcode engine, whose boxes are replaced, not redeployed.
   */
  async upgradeAgent(sandboxId: string, secret: string, sessionEnv: Record<string, string>): Promise<void> {
    if (!this.upgradesAgents) {
      throw new Error("A jcode computer's agent is replaced with its box, not upgraded in place.");
    }
    // Shared by every provider instance (one is made per request for a
    // user's own sandbox), so two requests never redeploy one box at once.
    const key = `${this.name}:${sandboxId}`;
    const running = UPGRADING.get(key);
    if (running) return running;
    const upgrade = (async () => {
      const box = await this.backend.get(sandboxId);
      await deployClaude(box.io, await this.binary(), secret, {
        root: await box.home(),
        sessionEnv: boxEnvironment(sandboxId, sessionEnv, !!box.growMemory),
      });
    })().finally(() => UPGRADING.delete(key));
    UPGRADING.set(key, upgrade);
    return upgrade;
  }

  /** A URL the owner's browser opens the box's `port` at, for `ttlSeconds`,
   *  with a way to end it before then (the editor's link is ended when the
   *  next is minted, lib/runtime/editor-link.ts); null where the provider
   *  can't make one. */
  async browserUrl(sandboxId: string, port: number, ttlSeconds: number): Promise<BrowserLink | null> {
    const box = await this.backend.get(sandboxId);
    return box.browserUrl ? box.browserUrl(port, ttlSeconds) : null;
  }

  /** The WebSocket the owner's browser views the box's desktop through, for
   *  `ttlSeconds`, the desktop started first if it wasn't running; null where
   *  the provider has no desktop. */
  async openDesktop(sandboxId: string, ttlSeconds: number): Promise<string | null> {
    const box = await this.backend.get(sandboxId);
    if (!box.desktop) return null;
    await box.desktop.start();
    return box.desktop.viewerUrl(ttlSeconds);
  }

  /** How this server reaches the box's `port` for a preview it proxies;
   *  null where the provider has no way in. */
  async previewTarget(sandboxId: string, port: number): Promise<PreviewTarget | null> {
    const box = await this.backend.get(sandboxId);
    return box.previewTarget ? box.previewTarget(port) : null;
  }

  /**
   * Build the {@link AgentTarget} an {@link AgentClient} needs for one box. Its
   * endpoint is kept a few minutes (lib/runtime/agent-endpoint-cache.ts);
   * `fresh` looks it up again, for a caller whose connection to it failed.
   */
  async agentTarget(sandboxId: string, secret: string, options: { fresh?: boolean } = {}): Promise<AgentTarget> {
    const endpoint = await AGENT_ENDPOINTS.get(
      this.endpointKey(sandboxId),
      async () => (await this.backend.get(sandboxId)).agentEndpoint(AGENT_PORT),
      options,
    );
    return { ...endpoint, secret };
  }

  private endpointKey(sandboxId: string): string {
    return `${this.name}:${sandboxId}`;
  }

  private forgetEndpoint(sandboxId: string): void {
    AGENT_ENDPOINTS.forget(this.endpointKey(sandboxId));
  }

  // --- RuntimeProvider interface --------------------------------------------
  // Workspace/session operations run through AgentClient (wired at the route
  // layer), not the provider. These implementations intentionally take no
  // arguments — a narrower signature still satisfies the interface — because
  // every one throws.

  createWorkspace(): Promise<CreateWorkspaceResult> {
    return notWiredYet("createWorkspace");
  }

  resumeWorkspace(): Promise<{ sandboxId: string }> {
    return notWiredYet("resumeWorkspace");
  }

  sandboxAlive(): Promise<boolean> {
    return notWiredYet("sandboxAlive");
  }

  listChangedFiles(): Promise<ChangedFile[]> {
    return notWiredYet("listChangedFiles");
  }

  readChangedFileDiff(): Promise<string> {
    return notWiredYet("readChangedFileDiff");
  }

  commitWorkspace(): Promise<CommitWorkspaceResult> {
    return notWiredYet("commitWorkspace");
  }

  pushWorkspaceBranch(): Promise<void> {
    return notWiredYet("pushWorkspaceBranch");
  }

  suspendWorkspace(): Promise<void> {
    return notWiredYet("suspendWorkspace");
  }

  destroyWorkspace(): Promise<void> {
    return notWiredYet("destroyWorkspace");
  }

  createPullRequest(): Promise<CreatePullRequestResult> {
    return notWiredYet("createPullRequest");
  }
}

/** Whether a provider is a Runtime Computer one (Daytona, Neev): the routes
 *  that drive a box per project through its agent need one. */
export function isComputerProvider(
  provider: RuntimeProvider,
): provider is ComputerRuntimeProvider {
  return provider instanceof ComputerRuntimeProvider;
}

function notWiredYet(op: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${op} is not on a Runtime Computer provider — interactive workspaces are driven ` +
        `through AgentClient (wired at the route layer in M2 pt3 / M3).`,
    ),
  );
}

/** Whether a backend's error says the box isn't there: Daytona's
 *  DaytonaNotFoundError, or a 404 from any of them. */
export function boxGone(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, status, statusCode } = error as { name?: unknown; status?: unknown; statusCode?: unknown };
  return (typeof name === "string" && name.endsWith("NotFoundError")) || status === 404 || statusCode === 404;
}

/** A box's agent boots with its user's environment, and with what it asks
 *  Outrunner for GitHub tokens with (lib/runtime/git-credential.ts). */
function boxEnvironment(sandboxId: string, sessionEnv: Record<string, string> | undefined, scalesMemory: boolean): Record<string, string> {
  return {
    ...sessionEnv,
    ...gitCredentialEnvironment(sandboxId, optionalEnv("RUNTIME_BASE_URL")),
    RUNTIME_MEMORY_AUTOSCALING: scalesMemory ? "1" : "0",
  };
}
