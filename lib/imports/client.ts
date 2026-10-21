/**
 * Running an import from the page: plan the picked sessions with the server,
 * then for each one it can take, have the desktop app capture and upload it,
 * then commit it. Two at a time: each upload is long, and the user's uplink is
 * shared.
 *
 * Its collaborators are passed in, so it tests without the app or the network.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
import { settableEnv } from "@/lib/imports/settable-env";
import type {
  ImportCapture,
  ImportCommitRequest,
  ImportConfigCapture,
  ImportConfigCommitRequest,
  ImportEnvCapture,
  ImportPlanItem,
  ImportPlanRequest,
  ImportSkip,
  ScannedAgentConfig,
  ScannedProjectEnv,
  ScannedSession,
  SkipReason,
} from "@/lib/runtime/import-scan";

/** Sessions captured and uploaded at once. */
const IMPORT_CONCURRENCY = 2;

export type ImportState = "waiting" | "uploading" | "saving" | "done" | "skipped" | "failed";

export type ImportProgress = {
  key: string;
  state: ImportState;
  /** The workspace it became, once done. */
  workspaceId?: string;
  /** The branch it is imported as, once planned. */
  branch?: string;
  /** Why it was skipped or failed. */
  message?: string;
};

/** Each state as a session's row shows it. */
export const IMPORT_STATE_LABELS: Record<ImportState, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  saving: "Saving",
  done: "Imported",
  skipped: "Skipped",
  failed: "Failed",
};

/** What the user agrees to by importing a session, said where they pick. */
export const IMPORT_UPLOAD_NOTE =
  "Each session's unpushed commits, uncommitted changes and full conversation are uploaded to your Outrunner cloud. A conversation can include anything its agent read, secrets too.";

/** What a session brings with it, for its row: "2 unpushed commits · 0.1 MB conversation". */
export function sessionFacts(s: ScannedSession): string[] {
  return [
    s.unpushed > 0 && `${s.unpushed} unpushed ${s.unpushed === 1 ? "commit" : "commits"}`,
    s.checkedOut && s.dirty && "uncommitted changes",
    !s.checkedOut && "its folder is on another branch: committed work only",
    `${(s.transcriptBytes / 1_000_000).toFixed(1)} MB conversation`,
  ].filter((fact): fact is string => typeof fact === "string");
}

/**
 * What is left of `progress` once a run has ended: the sessions that never
 * started are dropped. {@link importSessions} reports every picked session as
 * "waiting" before it plans them, so a plan that fails leaves them all on
 * "Waiting", reading as an import still under way. Nothing is waiting once
 * the run is over, so the state only ever means that.
 */
export function withoutUnstarted(progress: Record<string, ImportProgress>): Record<string, ImportProgress> {
  return Object.fromEntries(Object.entries(progress).filter(([, p]) => p.state !== "waiting"));
}

/**
 * How an import went, in a few words: "2 imported, 1 failed". Sessions still
 * under way read as "Importing… 1 of 3 done". Empty with nothing to say.
 */
export function importSummary(progress: ImportProgress[]): string {
  if (progress.length === 0) return "";
  const count = (state: ImportState) => progress.filter((p) => p.state === state).length;
  const ended = count("done") + count("skipped") + count("failed");
  if (ended < progress.length) return `Importing… ${ended} of ${progress.length} done`;
  return (
    [
      [count("done"), "imported"],
      [count("skipped"), "skipped"],
      [count("failed"), "failed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(", ");
}

export type ImportDeps = {
  plan(request: ImportPlanRequest): Promise<ImportPlanItem[]>;
  /** The desktop app's capture and upload: the capture, or why it can't. */
  capture(key: string, uploads: Record<string, string>): Promise<ImportCapture | { skip: ImportSkip }>;
  commit(request: ImportCommitRequest): Promise<{ workspace: { id: string } }>;
  onProgress(progress: ImportProgress): void;
};

/** Import `sessions` (each importable: a repo and branch), reporting each one's progress. */
export async function importSessions(
  sessions: ScannedSession[],
  options: { branchAs?: Record<string, string>; again?: string[] },
  deps: ImportDeps,
): Promise<void> {
  const picked = sessions.filter((s) => s.repo && s.branch && !s.skip);
  for (const s of picked) deps.onProgress({ key: s.key, state: "waiting" });
  const items = await deps.plan({
    sessions: picked.map((s) => ({
      key: s.key,
      source: s.source,
      agent: s.agent,
      repo: s.repo!,
      branch: s.branch!,
      ...(options.branchAs?.[s.key] && { branchAs: options.branchAs[s.key] }),
      ...(options.again?.includes(s.key) && { again: true }),
    })),
  });

  await mapWithConcurrency(items, IMPORT_CONCURRENCY, async (item) => {
    if (item.status === "skipped") {
      deps.onProgress({ key: item.key, state: "skipped", message: skipText(item.skip) });
      return;
    }
    const progress = (state: ImportState, extra: Partial<ImportProgress> = {}) =>
      deps.onProgress({ key: item.key, state, branch: item.branch, ...extra });
    try {
      progress("uploading");
      const uploads = Object.fromEntries(Object.entries(item.uploads).map(([kind, upload]) => [kind, upload!.url]));
      const captured = await deps.capture(item.key, uploads);
      if ("skip" in captured) {
        progress("skipped", { message: skipText(captured.skip) });
        return;
      }
      progress("saving");
      const { workspace } = await deps.commit(commitRequestFor(item, captured));
      progress("done", { workspaceId: workspace.id });
    } catch (error) {
      progress("failed", { message: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** What the server is told of a session the app captured and uploaded. */
export function commitRequestFor(
  item: Extract<ImportPlanItem, { status: "ready" }>,
  capture: ImportCapture,
): ImportCommitRequest {
  const s = capture.session;
  const receipt = (kind: keyof ImportCapture["artifacts"]) => {
    const a = capture.artifacts[kind];
    return a && { sha256: a.sha256, size: a.size, ...(a.encoding && { encoding: a.encoding }) };
  };
  const bundle = receipt("bundle");
  const patch = receipt("patch");
  const conversation = receipt("conversation");
  const rollout = receipt("rollout");
  if (!bundle || !patch || !conversation || !s.worktree || !s.branch) {
    throw new Error("The app's capture of this session is incomplete. Update the app, then try again.");
  }
  return {
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    importedAt: item.importedAt,
    key: s.key,
    source: s.source,
    agent: s.agent,
    sessionId: s.sessionId,
    branch: item.branch,
    bundleRef: s.branch,
    title: s.title.slice(0, 200),
    worktree: s.worktree,
    ...(s.startedAt && { startedAt: s.startedAt }),
    lastCommit: capture.lastCommit,
    unpushed: s.unpushed,
    changedFiles: capture.changedFiles,
    ...(s.lastMessage && { lastMessage: s.lastMessage.slice(0, 2000) }),
    artifacts: { bundle, patch, conversation, ...(rollout && { rollout }) },
  };
}

const SKIP_TEXT: Record<SkipReason, string> = {
  "no-github-remote": "Its folder isn't a GitHub repository.",
  "no-repo-access": "Your GitHub account can't see its repository.",
  "worktree-missing": "Its folder is gone.",
  "branch-missing": "Its branch is gone.",
  "branch-taken": "Its branch is already a session's in this project.",
  "too-large": "It's too large to import.",
  "already-imported": "It was imported already.",
  "unportable-mcp": "It needs something that only runs on this Mac.",
  "unknown-conductor-schema": "This version of Conductor can't be read yet.",
  "source-unreadable": "Couldn't read it.",
  "transcript-missing": "Its conversation is gone.",
};

/** What to tell the user of a skip: why, and the detail when there is one. */
export function skipText(skip: ImportSkip): string {
  return skip.detail ? `${SKIP_TEXT[skip.reason]} (${skip.detail})` : SKIP_TEXT[skip.reason];
}

/** What of a repository's environment the user picked. */
export type EnvironmentPick = { repo: string; vars: string[]; files: string[]; scripts: boolean };

/** Nothing of a repository's environment picked. */
export function emptyEnvPick(repo: string): EnvironmentPick {
  return { repo, vars: [], files: [], scripts: false };
}

/** Whether a repository's pick asks for anything. */
export function hasEnvironmentPick(pick: { vars: string[]; files: string[]; scripts: boolean }): boolean {
  return pick.vars.length > 0 || pick.files.length > 0 || pick.scripts;
}

/** Whether a setup pick asks for anything. */
export function hasConfigPick(pick: ConfigPick): boolean {
  return pick.items.length > 0 || pick.mcp.length > 0 || pick.plugins;
}

/** Whether a repository's pick carries secrets, so the user must agree
 *  first: variables and the files out of git hold them; scripts don't. */
export function environmentPickSecrets(pick: EnvironmentPick): boolean {
  return pick.vars.length > 0 || pick.files.length > 0;
}

/** Whether a setup pick carries secrets: an MCP server's settings carry its
 *  keys; items and plugin names don't. */
export function configPickSecrets(pick: ConfigPick): boolean {
  return pick.mcp.length > 0;
}

/**
 * The sessions a scan offers, and those it names that can't be imported. A
 * workspace archived in Conductor is neither: it is work the user put away.
 * (A scan from an app before it left them out still lists them.)
 */
export function offeredSessions(sessions: ScannedSession[]): { importable: ScannedSession[]; blocked: ScannedSession[] } {
  const live = sessions.filter((s) => s.conductorState !== "archived");
  return { importable: live.filter((s) => !s.skip), blocked: live.filter((s) => s.skip) };
}

/**
 * The environment the Mac has for `repo` (owner/name, in any case), or null
 * when it has none to offer. A variable a cloud session may not set is left
 * out: the server drops it on the way, so offering it would say it was kept
 * when it wasn't.
 */
export function environmentFor(projects: ScannedProjectEnv[], repo: string): ScannedProjectEnv | null {
  const project = projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase());
  if (!project) return null;
  const vars = project.vars.filter((v) => settableEnv(v.name));
  if (vars.length === 0 && project.files.length === 0 && !project.scripts) return null;
  return { ...project, vars };
}

/**
 * The setup picks a scan still offers. "Scan again" can drop an item — its
 * pick stays in state but stops rendering, so without this the Import button
 * stays enabled with nothing visibly checked.
 */
export function configInScan(config: ConfigPick, scan: { config: ScannedAgentConfig } | null): ConfigPick {
  if (!scan) return { items: [], mcp: [], plugins: false };
  const items = new Set(scan.config.items.filter((i) => !i.skip).map((i) => i.id));
  const servers = new Set(scan.config.mcpServers.filter((s) => !s.skip).map((s) => s.name));
  return {
    items: config.items.filter((id) => items.has(id)),
    mcp: config.mcp.filter((name) => servers.has(name)),
    plugins: config.plugins && scan.config.plugins.length > 0,
  };
}

export type EnvironmentDeps = {
  /** The desktop app's read of the picked values. */
  read(repo: string, pick: Omit<EnvironmentPick, "repo">): Promise<ImportEnvCapture>;
  save(capture: ImportEnvCapture): Promise<{ refused: string[] }>;
};

/** One repository's environment imported, or why not. */
export type EnvironmentResult = { repo: string; ok: boolean; message?: string };

/** Import each picked repository's environment, one after another. */
export async function importEnvironments(picks: EnvironmentPick[], deps: EnvironmentDeps): Promise<EnvironmentResult[]> {
  const results: EnvironmentResult[] = [];
  for (const { repo, ...pick } of picks) {
    if (!hasEnvironmentPick(pick)) continue;
    try {
      const { refused } = await deps.save(await deps.read(repo, pick));
      results.push({
        repo,
        ok: true,
        ...(refused.length > 0 && { message: `Left out ${refused.join(", ")}: cloud sessions set those themselves.` }),
      });
    } catch (error) {
      results.push({ repo, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** What of the user's own agent setup they picked. */
export type ConfigPick = { items: string[]; mcp: string[]; plugins: boolean };

export type ConfigDeps = {
  /** Where to upload the archive. */
  plan(): Promise<{ path: string; url: string }>;
  /** The desktop app's archive and upload, and read of the MCP servers. */
  capture(pick: ConfigPick & { upload: string | null }): Promise<ImportConfigCapture | { skip: ImportSkip }>;
  commit(request: ImportConfigCommitRequest): Promise<unknown>;
};

/** Import the user's picked setup; it replaces any imported before. */
export async function importAgentConfig(pick: ConfigPick, deps: ConfigDeps): Promise<{ ok: boolean; message?: string }> {
  if (!hasConfigPick(pick)) return { ok: true };
  try {
    const upload = pick.items.length > 0 ? await deps.plan() : null;
    const captured = await deps.capture({ ...pick, upload: upload?.url ?? null });
    if ("skip" in captured) return { ok: false, message: skipText(captured.skip) };
    if (upload && !captured.archive) throw new Error("The app made no archive of your setup. Update the app, then try again.");
    await deps.commit({
      ...(upload &&
        captured.archive && {
          archive: { path: upload.path, sha256: captured.archive.sha256, size: captured.archive.size },
        }),
      items: captured.items,
      mcpServers: captured.mcpServers as ImportConfigCommitRequest["mcpServers"],
      settings: captured.settings,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
