import { isDesktopApp } from "@/lib/is-desktop";

/**
 * Desktop-only "Connect Claude" bridge.
 *
 * The shell runs `claude setup-token` on the user's machine under a PTY and
 * hands back the minted token; the web app never sees the local CLI and the
 * user never opens a terminal.
 *
 * Two steps rather than one, because the CLI's flow has a browser round-trip in
 * the middle: it prints an authorize URL, then blocks waiting for the code that
 * URL produces. The code cannot be intercepted — `setup-token`'s redirect_uri is
 * fixed to platform.claude.com — so a human carries it back. `start` returns the
 * URL to open; `submit` feeds the code in and returns the token.
 */

/** The slice of the injected Tauri global we rely on (withGlobalTauri: true). */
type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
};

/**
 * Extract a Claude token from the native command's result. The command returns
 * just the token, but we parse defensively in case any surrounding output slips
 * through. Returns null when nothing token-shaped is present.
 */
export function parseSetupToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Prefer an explicit Anthropic token anywhere in the output.
  const match = trimmed.match(/sk-ant-[A-Za-z0-9_-]{10,}/);
  if (match) return match[0];

  // Otherwise accept a single opaque token line (no whitespace, plausible size).
  if (!/\s/.test(trimmed) && trimmed.length >= 20 && trimmed.length <= 500) {
    return trimmed;
  }
  return null;
}

/** Human-readable message for a native-side error code. */
export function messageForError(code: string): string {
  switch (code) {
    case "claude-cli-not-found":
      return "Claude Code isn't installed on this machine. Install it, then try again.";
    case "no-authorize-url":
      return "Claude Code didn't return a sign-in link. Check that `claude setup-token` runs in your terminal.";
    case "no-login-in-progress":
      return "That sign-in expired. Start again.";
    case "empty-code":
      return "Paste the code from the browser first.";
    case "no-token-in-output":
      return "That code wasn't accepted. Check you copied all of it, then start again.";
    case "claude-setup-token-failed":
      return "Couldn't get a token from Claude. Make sure you can run `claude setup-token`.";
    default:
      return code || "Connecting to Claude failed.";
  }
}

function invoker(): (cmd: string, args?: unknown) => Promise<unknown> {
  if (!isDesktopApp()) {
    throw new Error("Connecting Claude is only available in the desktop app.");
  }
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    throw new Error("The desktop bridge is unavailable. Restart the app and try again.");
  }
  return invoke;
}

/** Errors from `invoke` arrive as the bare string the Rust side returned. */
function toMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return messageForError(code);
}

/**
 * Start the native login. Returns the URL the user must open to authorize; the
 * CLI stays running, blocked on its code prompt, until `submitClaudeCode`.
 */
export async function startClaudeLogin(): Promise<string> {
  const invoke = invoker();
  try {
    const url = await invoke("connect_claude_start");
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("no-authorize-url");
    }
    return url;
  } catch (error) {
    throw new Error(toMessage(error));
  }
}

/** Hand the browser's code to the waiting CLI and return the minted token. */
export async function submitClaudeCode(code: string): Promise<string> {
  const invoke = invoker();
  let raw: unknown;
  try {
    raw = await invoke("connect_claude_submit", { code });
  } catch (error) {
    throw new Error(toMessage(error));
  }
  const token = parseSetupToken(raw);
  if (!token) {
    throw new Error(messageForError("no-token-in-output"));
  }
  return token;
}

/** Abandon a login in progress, so a retry starts from a clean CLI. */
export async function cancelClaudeLogin(): Promise<void> {
  try {
    await invoker()("connect_claude_cancel");
  } catch {
    // Best effort: the shell drops the child on the next start anyway.
  }
}
