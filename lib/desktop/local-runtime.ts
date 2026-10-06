import { isDesktopApp } from "@/lib/is-desktop";

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
};

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
  running: boolean;
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

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await requireCore().invoke(cmd, args)) as T;
  } catch (error) {
    throw new Error(messageForLocalError(error));
  }
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

/** Ask for a folder to work in; null when the user cancels. */
export function pickLocalFolder(): Promise<LocalFolder | null> {
  return call<LocalFolder | null>("local_pick_folder");
}

/** Re-check a remembered folder: it may have moved or gone. */
export function checkLocalFolder(path: string): Promise<LocalFolder> {
  return call<LocalFolder>("local_check_folder", { path });
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

/** Human-readable message for an error the app returned. */
export function messageForLocalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
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
    case "agent":
      // The agent's own message, e.g. a worktree that could not be created.
      return raw.slice("agent:".length).trim() || "The local agent reported an error.";
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
