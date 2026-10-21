/**
 * Running an import from the page: plan the picked sessions with the server,
 * then for each one it can take, have the desktop app capture and upload it,
 * then commit it. Two at a time: each upload is long, and the user's uplink is
 * shared.
 *
 * Its collaborators are passed in, so it tests without the app or the network.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
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

/** Whether a repository's pick asks for anything. */
export function hasEnvironmentPick(pick: { vars: string[]; files: string[]; scripts: boolean }): boolean {
  return pick.vars.length > 0 || pick.files.length > 0 || pick.scripts;
}

/** Whether a setup pick asks for anything. */
export function hasConfigPick(pick: ConfigPick): boolean {
  return pick.items.length > 0 || pick.mcp.length > 0 || pick.plugins;
}

/** Whether anything picked carries secrets, so the user must agree first:
 *  variables and the files out of git hold them, and an MCP server's settings
 *  carry its keys. Scripts, items and plugin names don't. */
export function picksSecrets(envs: EnvironmentPick[], config: ConfigPick): boolean {
  return envs.some((e) => e.vars.length > 0 || e.files.length > 0) || config.mcp.length > 0;
}

/**
 * The picks a scan still offers. "Scan again" can drop a project or an item —
 * its pick stays in state but stops rendering, so without this the Import
 * button stays enabled with nothing visibly checked and a repository that is
 * gone is still read off the Mac.
 */
export function picksInScan(
  picks: Record<string, EnvironmentPick>,
  config: ConfigPick,
  scan: { projects: ScannedProjectEnv[]; config: ScannedAgentConfig } | null,
): { envs: EnvironmentPick[]; config: ConfigPick } {
  if (!scan) return { envs: [], config: { items: [], mcp: [], plugins: false } };
  const repos = new Set(scan.projects.map((p) => p.repo));
  const items = new Set(scan.config.items.filter((i) => !i.skip).map((i) => i.id));
  const servers = new Set(scan.config.mcpServers.filter((s) => !s.skip).map((s) => s.name));
  return {
    envs: Object.values(picks).filter((p) => repos.has(p.repo)),
    config: {
      items: config.items.filter((id) => items.has(id)),
      mcp: config.mcp.filter((name) => servers.has(name)),
      plugins: config.plugins && scan.config.plugins.length > 0,
    },
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
