import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { sharedResource } from "@/lib/client/shared-resource";
import { cliReason } from "@/lib/desktop/cli-reason";
import { isDesktopApp } from "@/lib/is-desktop";
import { isProviderId, type ProviderId } from "@/lib/providers/registry";
import {
  ImportCapture,
  ImportCaptureSkip,
  ImportConfigCapture,
  ImportEnvCapture,
  ImportScan,
  type ImportSkip,
} from "@/lib/runtime/import-scan";
import { EMPTY_LOADOUT, type ModelLoadout, parseLoadout } from "@/lib/runtime/model-loadout";
import {
  checkEffortApplied,
  defaultModel,
  type Effort,
  type KeyHolder,
  type ModelMenu,
  predatesProvider,
  predatesProviderMessage,
  setModelRequest,
  type SessionModel,
} from "@/lib/runtime/session-models";

/**
 * Desktop-only bridge for local sessions: Claude Code running on this Mac.
 *
 * The page cannot reach the agent there itself — WKWebView blocks http/ws to
 * 127.0.0.1 from an https page — so the Outrunner app owns it: it starts the
 * agent, mints its tokens, and relays calls. This module is the page's side of
 * that relay (runtime-desktop/src-tauri/src/local_runtime.rs is the other).
 */

/** The slice of the injected Tauri global we rely on (withGlobalTauri: true). */
type TauriCore = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  Channel: new <T>() => { onmessage: (message: T) => void };
};

/** Which workspace a relayed call is for; the app mints a token per call. */
export type LocalTarget = { workspaceId: string; projectId: string };

/**
 * Local sessions belong to a folder, not a GitHub project; the agent's tokens
 * still carry a project claim, so they all carry this one.
 */
export const LOCAL_PROJECT = "local";

export function localTarget(workspaceId: string): LocalTarget {
  return { workspaceId, projectId: LOCAL_PROJECT };
}

export type LocalStatus = {
  deviceId: string;
  /** Where the agent keeps worktrees, e.g. /Users/ada/.outrunner. */
  root: string;
  agentBundled: boolean;
  git: string | null;
  tmux: string | null;
  claude: string | null;
  /** Whether that Claude Code is logged in; null when the app cannot tell.
   *  Absent from an app built before it checked. */
  claudeLoggedIn?: boolean | null;
  /** The app setting up its own Claude Code; null when it isn't. Absent from
   *  an app built before it could, which leaves installing it to the user. */
  claudeSetup?: ClaudeSetup | null;
  /** Each agent CLI a local session can run, on this Mac's own login of it.
   *  Absent from an app built before Codex: read it through `agentCli`. */
  agents?: Record<AgentId, AgentCliStatus>;
};

/** One agent CLI on this Mac, as the app reports it. */
export type AgentCliStatus = {
  /** The one sessions run; null when this Mac has none. */
  path: string | null;
  /** Whether it is logged in; null when the app cannot tell. */
  loggedIn: boolean | null;
  /** How it is logged in, when it says (only Codex does). */
  method: "chatgpt" | "api-key" | null;
};

/** How to install Codex on a Mac; the app has no copy of its own to set up. */
export const CODEX_INSTALL_COMMAND = "npm i -g @openai/codex";

/** How to log each agent CLI in by hand. */
const MANUAL_LOGIN: Record<AgentId, string> = {
  claude: "Run `claude` in Terminal and type /login.",
  codex: "Run `codex login` in Terminal.",
};

/**
 * Outrunner downloading its own copy of Claude Code, for a Mac whose own is
 * missing, broken or too old for a session.
 */
export type ClaudeSetup =
  | { state: "installing"; received: number; total: number }
  | { state: "failed"; message: string };

export type LocalFolder = {
  /** A repository's top level (even if a subfolder was chosen), else the folder. */
  path: string;
  name: string;
  /** A repository with a commit: each session gets its own worktree. Otherwise
   *  Claude works in the folder itself. */
  git: boolean;
  /** The checked-out branch, when there is one. */
  branch: string | null;
};

/** One session the agent on this Mac knows (GET /workspaces on the agent). */
export type LocalSession = {
  workspaceId: string;
  /** The folder's name. */
  name: string;
  /** What the user first asked for. */
  title: string;
  folder: string;
  /** Where Claude works: a worktree, or the folder itself when `inPlace`. */
  worktree: string;
  branch: string;
  baseBranch: string;
  inPlace: boolean;
  createdAt: string;
  /** When Claude last wrote to the session (its transcript's time), else
   *  createdAt. Absent from agents bundled before it existed. */
  lastActiveAt?: string;
  running: boolean;
  /** The coding agent it runs; absent from an agent from before Codex, and
   *  for any session that runs Claude Code. */
  agent?: AgentId;
};

export function tauriCore(): TauriCore | null {
  if (!isDesktopApp()) return null;
  const core = (window as unknown as { __TAURI__?: { core?: Partial<TauriCore> } }).__TAURI__?.core;
  return core?.invoke && core.Channel ? (core as TauriCore) : null;
}

function requireCore(): TauriCore {
  const core = tauriCore();
  if (!core) throw new Error("Local sessions run in the Outrunner Mac app.");
  return core;
}

/** `agent` names the CLI a login error is about. */
async function call<T>(cmd: string, args?: Record<string, unknown>, agent: AgentId = "claude"): Promise<T> {
  try {
    return (await requireCore().invoke(cmd, args)) as T;
  } catch (error) {
    throw new Error(messageForLocalError(error, agent));
  }
}

/** Every session on this Mac that could move to the cloud, and why any can't;
 *  null outside the desktop app. */
export async function importScan(): Promise<ImportScan | null> {
  if (!tauriCore()) return null;
  return ImportScan.parse(await call<unknown>("import_scan"));
}

/** Capture the session with `key` and upload it to `uploads` (a signed URL per
 *  artifact kind): its capture, or why it can't be imported. */
export async function importSession(
  key: string,
  uploads: Record<string, string>,
): Promise<ImportCapture | { skip: ImportSkip }> {
  const result = await call<unknown>("import_session", { key, uploads });
  const skipped = ImportCaptureSkip.safeParse(result);
  return skipped.success ? skipped.data : ImportCapture.parse(result);
}

/** The values of what the user picked of a repository's environment on this
 *  Mac: variables by name, .env files by path, and its scripts. */
export async function importEnvironment(
  repo: string,
  pick: { vars: string[]; files: string[]; scripts: boolean },
): Promise<ImportEnvCapture> {
  return ImportEnvCapture.parse(await call<unknown>("import_environment", { repo, ...pick }));
}

/** Archive what the user picked of their own agent setup, upload it to
 *  `upload`, and read the picked MCP servers and plugin settings. */
export async function importConfig(pick: {
  items: string[];
  mcp: string[];
  plugins: boolean;
  upload: string | null;
}): Promise<ImportConfigCapture | { skip: ImportSkip }> {
  const result = await call<unknown>("import_config", pick);
  const skipped = ImportCaptureSkip.safeParse(result);
  return skipped.success ? skipped.data : ImportConfigCapture.parse(result);
}

/** What this Mac has for local sessions; null outside the desktop app. */
export async function localStatus(): Promise<LocalStatus | null> {
  if (!tauriCore()) return null;
  return call<LocalStatus>("local_status");
}

/** The tools a local session needs that this Mac is missing, in install order. */
export function missingTools(status: LocalStatus): string[] {
  const missing: string[] = [];
  if (!status.agentBundled) missing.push("the Outrunner agent");
  if (!status.git) missing.push("git");
  if (!status.tmux) missing.push("tmux");
  if (!status.claude) missing.push("Claude Code");
  return missing;
}

/** Whether the app sets Claude Code up itself instead of asking the user to. */
export function setsUpClaude(status: LocalStatus): boolean {
  return status.claudeSetup !== undefined;
}

/** The missing tools the user has to install: all but a Claude Code the app sets up. */
export function toolsToInstall(status: LocalStatus): string[] {
  const missing = missingTools(status);
  return setsUpClaude(status) ? missing.filter((tool) => tool !== "Claude Code") : missing;
}

/** Whether the app should start setting up its own Claude Code now: none runs
 *  here, and no setup is under way or has just failed. */
export function claudeSetupNeeded(status: LocalStatus): boolean {
  return !status.claude && status.claudeSetup === null;
}

/** Where setting up Claude Code has got to, for a line on the page. */
export function claudeSetupText(setup: ClaudeSetup | null | undefined): string {
  if (setup?.state === "failed") return setup.message;
  if (setup?.state === "installing" && setup.total > 0) {
    return `Setting up Claude Code for Outrunner… ${Math.floor((setup.received / setup.total) * 100)}%`;
  }
  return "Setting up Claude Code for Outrunner…";
}

/**
 * Start setting up Outrunner's own Claude Code, when this Mac has none that
 * runs a session. Resolves at once; `localStatus` follows the download.
 */
export function setUpClaudeCode(): Promise<void> {
  return call<void>("local_claude_setup");
}

/**
 * One agent CLI on this Mac. An app built before `agents` reports Claude Code
 * alone, in its own fields, and cannot log Codex in: it has none.
 */
export function agentCli(status: LocalStatus, agent: AgentId): AgentCliStatus {
  if (status.agents) return status.agents[agent];
  if (agent === "codex") return { path: null, loggedIn: null, method: null };
  return { path: status.claude, loggedIn: status.claudeLoggedIn ?? null, method: null };
}

/**
 * Whether a local session can run on `agent` with this Mac's own login of it:
 * `missing` when it isn't installed, `logged-out` on a clear no, else `ready`.
 * A login the app cannot read counts as ready: the CLI asks in the session.
 */
export function localAgentState(status: LocalStatus, agent: AgentId): "missing" | "logged-out" | "ready" {
  const cli = agentCli(status, agent);
  if (cli.path === null) return "missing";
  return cli.loggedIn === false ? "logged-out" : "ready";
}

/**
 * Whether this Mac's Claude Code must be logged in before a local session can
 * run. Only a clear no counts: an app that cannot tell, or predates the check,
 * leaves it to Claude Code's own /login in the session.
 */
export function needsClaudeLogin(status: LocalStatus): boolean {
  return localAgentState(status, "claude") === "logged-out";
}

/** Whether this Mac's Codex must be logged in before a local Codex session can
 *  run; as `needsClaudeLogin`, only on a clear no. */
export function needsCodexLogin(status: LocalStatus): boolean {
  return localAgentState(status, "codex") === "logged-out";
}

/**
 * Whether a new local session runs on Outrunner's model instead of this Mac's
 * Claude Code login: only on a clear "not logged in" from the app, and only
 * where the server runs Outrunner's models. Otherwise the login is a must.
 */
export function runsOnOutrunnerModel(status: LocalStatus, outrunnerModels: boolean): boolean {
  return outrunnerModels && needsClaudeLogin(status);
}

/** The key a local session's model runs on: Outrunner's (created for the
 *  user on first use), or one of the user's own (Settings → Providers). */
export async function modelKeyFor(holder: KeyHolder): Promise<string> {
  const res = await fetch("/api/outrunner-models/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holder }),
  });
  const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !data.key) throw new Error(data.error ?? "That model's key is unavailable right now.");
  return data.key;
}

/** Put a local session on `model` at `effort` (none: the model's own), before
 *  its first launch or as a switch: the agent records both, so the session
 *  runs on them from then on. */
export async function putOnModel(workspaceId: string, model: SessionModel, effort?: Effort | null): Promise<void> {
  const body = await setModelRequest(model, modelKeyFor, effort);
  try {
    checkEffortApplied(body, await localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/model`, body));
  } catch (error) {
    // The Mac's agent is older than the model's provider.
    if (error instanceof Error && predatesProvider(error.message)) throw new Error(predatesProviderMessage(model));
    throw error;
  }
}

/** Put a new local session on the menu's default model: on a Mac whose Claude
 *  Code isn't logged in, so it starts with no Claude login (and none of its
 *  login screens). */
export async function putOnDefaultModel(workspaceId: string): Promise<void> {
  const model = defaultModel(await outrunnerModels());
  if (!model) throw new Error("Outrunner's models aren't available. Log Claude Code in on this Mac to start a session.");
  await putOnModel(workspaceId, model);
}

/** The model menu, whether a session can start without the user's Claude,
 *  and the user's loadout (Settings → Default models). */
export type OutrunnerModels = ModelMenu & { available: boolean; loadout: ModelLoadout };
const NO_MODELS: OutrunnerModels = { outrunner: false, allowance: false, keys: [], available: false, loadout: EMPTY_LOADOUT };

/** What the user's model menu offers (GET /api/outrunner-models), and whether
 *  a session can start without their Claude; asked once per page load, or
 *  again after Settings → Providers changes a key. One answer for the page:
 *  read it with useSharedResource to show the last one at once. A failed look
 *  is asked again next time. */
export const OUTRUNNER_MODELS = sharedResource<OutrunnerModels>(
  () =>
    fetch("/api/outrunner-models")
      .then((res): Promise<Record<string, unknown>> | Record<string, unknown> => (res.ok ? res.json() : {}))
      .then(parseOutrunnerModels),
  NO_MODELS,
);

function parseOutrunnerModels(data: Record<string, unknown>): OutrunnerModels {
  const keys = Array.isArray(data.keys)
    ? data.keys.filter(isProviderId)
    : // A server from before providers says only whether there's an OpenRouter key.
      data.ownKey === true
      ? (["openrouter"] as ProviderId[])
      : [];
  const outrunner = typeof data.outrunner === "boolean" ? data.outrunner : data.serverModels === true;
  return {
    outrunner,
    allowance: data.allowance === true,
    keys,
    available: data.available === true,
    // A server from before loadouts sends none.
    loadout: parseLoadout(data.loadout),
  };
}

/** The menu, looked up if not yet held; none on offer when it can't be. */
export function outrunnerModels(): Promise<OutrunnerModels> {
  return OUTRUNNER_MODELS.ensure().catch(() => NO_MODELS);
}

/** Ask again next time: one of the user's keys, or their loadout, has just
 *  changed. */
export function forgetOutrunnerModels(): void {
  OUTRUNNER_MODELS.invalidate();
}

/**
 * Log Claude Code in on this Mac. The app runs `claude auth login`, which opens
 * the browser; this resolves once the user has approved there.
 */
export function logInToClaude(): Promise<void> {
  return call<void>("local_claude_login");
}

/** Stop a `logInToClaude` in progress. */
export function cancelClaudeLogin(): Promise<void> {
  return call<void>("local_claude_login_cancel");
}

/**
 * Log Codex in on this Mac. The app runs `codex login`, which opens the browser
 * to sign in with ChatGPT; this resolves once that is done. A Claude Code login
 * under way carries on.
 */
export function logInToCodex(): Promise<void> {
  return call<void>("local_codex_login", undefined, "codex");
}

/** Stop a `logInToCodex` in progress. */
export function cancelCodexLogin(): Promise<void> {
  return call<void>("local_codex_login_cancel", undefined, "codex");
}

/** Ask for a folder to work in; null when the user cancels. */
export function pickLocalFolder(): Promise<LocalFolder | null> {
  return call<LocalFolder | null>("local_pick_folder");
}

/** Re-check a remembered folder: it may have moved or gone. */
export function checkLocalFolder(path: string): Promise<LocalFolder> {
  return call<LocalFolder>("local_check_folder", { path });
}

/**
 * Clone a repository picked from GitHub (`owner/name`) into ~/outrunner/repos,
 * or use the clone made before, as the folder a local session works in. The
 * user's GitHub token goes to the app for this clone only, so private
 * repositories clone too.
 */
export async function cloneLocalRepository(fullName: string): Promise<LocalFolder> {
  const res = await fetch("/api/github/clone-token", { method: "POST" });
  const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!res.ok || !data?.token) throw new Error(data?.error ?? "Couldn't reach GitHub for that repository.");
  return call<LocalFolder>("local_clone_repo", { fullName, token: data.token });
}

/** This Mac's local sessions, newest first. They live only on this Mac. */
export async function listLocalSessions(): Promise<LocalSession[]> {
  if (!tauriCore()) return [];
  return call<LocalSession[]>("local_list_sessions");
}

/** One control call to the local agent, through the app. */
export function localAgentRequest<T = unknown>(
  target: LocalTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return call<T>("local_agent_request", {
    method,
    path,
    body: body ?? null,
    workspaceId: target.workspaceId,
    projectId: target.projectId,
  });
}

// ---------------------------------------------------------------------------
// The folder the last local session used, remembered on this Mac so the next
// one starts there. A stale entry is harmless: it is re-checked before use.
// ---------------------------------------------------------------------------

const FOLDER_KEY = "outrunner:local-folder";

export function rememberedFolder(): string | null {
  try {
    return window.localStorage.getItem(FOLDER_KEY);
  } catch {
    return null;
  }
}

export function rememberFolder(path: string | null): void {
  try {
    if (path) window.localStorage.setItem(FOLDER_KEY, path);
    else window.localStorage.removeItem(FOLDER_KEY);
  } catch {
    // Private mode or blocked storage: the user just picks the folder again.
  }
}

/**
 * What an app older than the page says for a command it doesn't have yet. The
 * page goes live with a deploy, the app only when the user updates it.
 */
const NEEDS_NEWER_APP: Record<string, string> = {
  local_clone_repo:
    "This version of the Outrunner app can't clone repositories. Update the app, or choose a folder on this Mac instead.",
  local_codex_login: "This version of the Outrunner app can't log Codex in. Update the app, then try again.",
  import_scan: "This version of the Outrunner app can't import sessions. Update the app, then try again.",
  import_session: "This version of the Outrunner app can't import sessions. Update the app, then try again.",
  import_environment: "This version of the Outrunner app can't import a project's environment. Update the app, then try again.",
  import_config: "This version of the Outrunner app can't import your agent setup. Update the app, then try again.",
};

/** Human-readable message for an error the app returned; `agent` is the CLI a
 *  login error is about. */
export function messageForLocalError(error: unknown, agent: AgentId = "claude"): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // Tauri's refusal of a command the app doesn't have.
  const missing = /^(\w+) not allowed\. Command not found$/.exec(raw);
  if (missing) {
    return NEEDS_NEWER_APP[missing[1]] ?? "This version of the Outrunner app can't do that yet. Update the app, then try again.";
  }
  const code = raw.split(":")[0];
  switch (code) {
    case "agent-missing":
      return "This build of the Outrunner app has no local agent. Update the app to run sessions locally.";
    case "agent-did-not-start":
    case "agent-spawn-failed":
      return "The local agent didn't start. Its log is ~/.outrunner/agent.log.";
    case "agent-unreachable":
      return "Lost contact with the local agent. Try again.";
    case "folder-missing":
      return "That folder isn't there any more. Choose another.";
    case "clone-failed": {
      const said = raw.slice("clone-failed:".length).trim();
      return said ? `Couldn't clone that repository. git said: ${said}` : "Couldn't clone that repository.";
    }
    case "git-missing":
      return "Cloning needs git. Install the Xcode Command Line Tools (run `xcode-select --install`), then try again.";
    case "repo-folders-taken":
      return "~/outrunner/repos already has folders of that name. Move some away and try again.";
    case "repo-invalid":
      return "That isn't a GitHub repository name.";
    case "repo-folder":
      return "Couldn't make a folder in ~/outrunner/repos for it.";
    case "folder-not-chosen":
    case "folder-required":
      // The app only works in folders picked in its own dialog.
      return "Choose the folder to work in again.";
    case "claude-missing":
      return "Install Claude Code to run sessions on this Mac.";
    case "codex-missing":
      return `Install Codex to run Codex sessions on this Mac: run \`${CODEX_INSTALL_COMMAND}\` (or \`brew install --cask codex\`) in Terminal, then try again.`;
    case "login-cancelled":
      return `The ${AGENTS[agent].label} login was stopped. Try again.`;
    case "login-timed-out":
      return "No approval came from the browser. Try again.";
    case "login-failed": {
      const name = AGENTS[agent].label;
      const said = cliReason(raw.slice("login-failed:".length));
      return said ? `${name} couldn't log in. It said: ${said}` : `${name} couldn't log in. ${MANUAL_LOGIN[agent]}`;
    }
    case "import-failed": {
      const said = raw.slice("import-failed:".length).trim();
      return said ? `The import failed: ${said}` : "The import failed. Try again.";
    }
    case "invalid-item":
    case "invalid-mcp":
    case "invalid-repo":
    case "invalid-variable":
    case "invalid-file":
    case "too-many":
    case "invalid-session-key":
    case "upload-not-allowed":
    case "unknown-artifact":
    case "no-uploads":
      return "The app refused that import. Scan again, then try again.";
    case "agent": {
      // The agent's own message, e.g. a worktree that could not be created.
      const said = raw.slice("agent:".length).trim();
      // Its answer for a session it has no folder for: deleted, or from
      // another Mac.
      if (said === "unknown workspace") return "This session isn't on this Mac any more. It may have been deleted.";
      return said || "The local agent reported an error.";
    }
    default:
      return raw || "The local session failed.";
  }
}

// ---------------------------------------------------------------------------
// Sockets. The session client opens WebSockets by URL; a local session's URLs
// use this scheme instead of ws(s), and openSocket() relays those through the
// app. The URL carries only which stream and which workspace — the token is
// minted on the app side and never reaches the page.
// ---------------------------------------------------------------------------

export const LOCAL_SOCKET_PROTOCOL = "outrunner-local:";

export type LocalSocketKind = "pty" | "events";

export function localSocketUrl(kind: LocalSocketKind, target: LocalTarget): string {
  const query = new URLSearchParams({ workspace: target.workspaceId, project: target.projectId });
  return `outrunner-local://${kind}?${query}`;
}

export function parseLocalSocketUrl(
  url: string,
): { kind: LocalSocketKind; target: LocalTarget; lastEventId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== LOCAL_SOCKET_PROTOCOL) return null;
  const kind = parsed.host;
  const workspaceId = parsed.searchParams.get("workspace");
  const projectId = parsed.searchParams.get("project");
  if ((kind !== "pty" && kind !== "events") || !workspaceId || !projectId) return null;
  return { kind, target: { workspaceId, projectId }, lastEventId: parsed.searchParams.get("lastEventId") };
}

type SocketEvent =
  | { type: "open" }
  | { type: "message"; data: string }
  | { type: "close"; code: number; reason: string }
  | { type: "error"; message: string };

/**
 * A WebSocket look-alike over the app's relay: the subset of the WebSocket
 * interface the session client uses (readyState, send, close, and the
 * open/message/error/close events), so its code is unchanged for local sessions.
 */
export class LocalSocket extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  readyState: number = WebSocket.CONNECTING;
  private id: number | null = null;
  private closeWanted = false;
  /** Frames sent before the app returned the socket's id: the session client
   *  sends its first resize from the open handler, which can run first. */
  private queued: string[] = [];

  constructor(url: string) {
    super();
    const spec = parseLocalSocketUrl(url);
    const core = tauriCore();
    if (!spec || !core) {
      queueMicrotask(() => this.fail("Local sessions run in the Outrunner Mac app."));
      return;
    }
    const channel = new core.Channel<SocketEvent>();
    channel.onmessage = (event) => this.receive(event);
    core
      .invoke("local_socket_open", {
        kind: spec.kind,
        workspaceId: spec.target.workspaceId,
        projectId: spec.target.projectId,
        lastEventId: spec.lastEventId,
        onEvent: channel,
      })
      .then((id) => {
        this.id = id as number;
        if (this.closeWanted) {
          void core.invoke("local_socket_close", { id: this.id });
          return;
        }
        for (const data of this.queued.splice(0)) this.relay(data);
      })
      .catch((error: unknown) => this.fail(messageForLocalError(error)));
  }

  send(data: string): void {
    // As WebSocket.send: an error before open, silently dropped after close.
    if (this.readyState === WebSocket.CONNECTING) {
      throw new DOMException("LocalSocket is not open", "InvalidStateError");
    }
    if (this.readyState !== WebSocket.OPEN) return;
    if (this.id === null) this.queued.push(data);
    else this.relay(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    if (this.id === null) {
      this.closeWanted = true;
      return;
    }
    void tauriCore()?.invoke("local_socket_close", { id: this.id });
  }

  private relay(data: string): void {
    void tauriCore()
      ?.invoke("local_socket_send", { id: this.id, data })
      .catch(() => {
        // The relay already closed; its close event reaches the caller.
      });
  }

  private receive(event: SocketEvent): void {
    // A closed WebSocket fires nothing more; neither does this, whatever the
    // channel still delivers. (The relay ends every error with a close, so an
    // error alone never strands the socket open.)
    if (this.readyState === WebSocket.CLOSED) return;
    switch (event.type) {
      case "open":
        if (this.readyState !== WebSocket.CONNECTING) return;
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
        break;
      case "message":
        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
        break;
      case "error":
        this.dispatchEvent(new Event("error"));
        break;
      case "close":
        this.finish(event.code, event.reason);
        break;
    }
  }

  private fail(message: string): void {
    console.warn("Local session socket failed:", message);
    this.dispatchEvent(new Event("error"));
    this.finish(1006, message);
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }
}

/** Open a session stream: a real WebSocket, or the app's relay for a local URL. */
export function openSocket(url: string): WebSocket {
  return url.startsWith(LOCAL_SOCKET_PROTOCOL)
    ? (new LocalSocket(url) as unknown as WebSocket)
    : new WebSocket(url);
}
