import { cliReason } from "@/lib/desktop/cli-reason";
import { isDesktopApp } from "@/lib/is-desktop";

/**
 * Desktop-only "Connect Claude" bridge.
 *
 * The shell runs `claude setup-token` on the user's machine under a PTY and
 * hands back the minted token; the web app never sees the local CLI and the
 * user never opens a terminal.
 *
 * The flow has a browser round-trip in the middle: `start` returns an authorize
 * URL to open, and authorizing there normally finishes the login by itself — the
 * CLI prints the token with nothing pasted, which `pollClaudeLogin` picks up. So
 * the happy path is genuinely one click.
 *
 * `submitClaudeCode` covers the case where the CLI falls back to asking for a
 * code on its terminal. Keep it: assuming the prompt always appears is what made
 * the first version demand a code that was never issued.
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
  // `no-authorize-url` arrives with the CLI's own last lines appended, so that a
  // failure on someone else's machine says what Claude Code actually did rather
  // than only that it didn't work. Common cause: Claude Code has never been run
  // interactively there, so its first-run onboarding is on screen instead.
  if (code.startsWith("no-authorize-url:")) {
    const detail = code.slice("no-authorize-url:".length).trim();
    return (
      "Claude Code didn't return a sign-in link. Try running `claude` once in " +
      `your terminal to clear any first-run setup, then reconnect. It said: ${detail}`
    );
  }
  // `setup-token` only works for a Claude subscription, and exits without a
  // token for an account that has none or when the browser approval is
  // declined. Say so rather than keep waiting.
  if (code === "setup-token-exited" || code.startsWith("setup-token-exited:")) {
    const detail = cliReason(code.slice("setup-token-exited".length).replace(/^:\s*/, ""));
    return (
      "Claude Code stopped without issuing a token. Connecting needs a Claude Pro " +
      "or Max subscription on the account you approve with." +
      (detail ? ` It said: ${detail}` : "")
    );
  }
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
 * CLI stays running until it completes on its own (see `pollClaudeLogin`) or
 * asks for a code (`submitClaudeCode`).
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

export type ClaudeLoginPoll =
  | { state: "waiting" }
  | { state: "done"; token: string }
  /** The attempt is over without a token here: cancelled, or a pasted code took it. */
  | { state: "ended" };

/**
 * Ask whether the CLI has finished on its own yet.
 *
 * The normal flow needs no code at all: authorizing in the browser completes
 * the login and the CLI prints the token unprompted. "waiting" means nothing
 * has arrived yet — the caller polls again — so the code field is only ever a
 * fallback for the case where the CLI does prompt. Throws, with a message for
 * the user, when the CLI exited without a token.
 */
export async function pollClaudeLogin(): Promise<ClaudeLoginPoll> {
  let raw: unknown;
  try {
    raw = await invoker()("connect_claude_poll");
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "no-login-in-progress") return { state: "ended" };
    throw new Error(messageForError(code));
  }
  if (raw == null) return { state: "waiting" };
  const token = parseSetupToken(raw);
  return token ? { state: "done", token } : { state: "waiting" };
}

/** Abandon a login in progress, so a retry starts from a clean CLI. */
export async function cancelClaudeLogin(): Promise<void> {
  try {
    await invoker()("connect_claude_cancel");
  } catch {
    // Best effort: the shell drops the child on the next start anyway.
  }
}
