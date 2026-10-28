/**
 * Plan mode, from the composer's side. A session's prompts go in one of two
 * modes: build, its own, or plan, where its agent reads and proposes a plan
 * rather than changing anything. The mode goes with each prompt (the agent
 * puts the session in it first, runtime-agent/internal/workspace/plan.go), so
 * a prompt queued in plan mode is planned whenever it is sent.
 *
 * The composer's toggle (Shift+Tab) picks the mode; `/plan <prompt>` sends one
 * prompt in plan mode and leaves the toggle there, as the session now is.
 * `/compact` compacts the conversation instead of sending anything.
 */

import type { SessionMode } from "@/lib/runtime/agent-protocol";

export type { SessionMode };

/** What the composer's text asks for, when it is one of its own commands
 *  rather than a prompt for the agent. Null for a prompt (any other slash
 *  command included: it goes to the agent's terminal as it always has). */
export type ComposerCommand =
  | { kind: "plan"; prompt: string }
  | { kind: "compact"; instructions: string }
  | null;

const PLAN = /^\/plan(?:\s+([\s\S]*))?$/;
const COMPACT = /^\/compact(?:\s+([\s\S]*))?$/;

export function composerCommand(text: string): ComposerCommand {
  const trimmed = text.trim();
  const plan = PLAN.exec(trimmed);
  if (plan) return { kind: "plan", prompt: (plan[1] ?? "").trim() };
  const compact = COMPACT.exec(trimmed);
  if (compact) return { kind: "compact", instructions: (compact[1] ?? "").trim() };
  return null;
}

/** The other mode: what Shift+Tab, or a click on the toggle, switches to. */
export function otherMode(mode: SessionMode): SessionMode {
  return mode === "plan" ? "build" : "plan";
}

const key = (workspaceId: string) => `outrunner:mode:${workspaceId}`;

/** The mode a session was last put in from this browser: a local session's
 *  record of it (its row is on this Mac alone), and a cloud session's until
 *  the page has the server's. Null where none was. */
export function rememberedMode(workspaceId: string): SessionMode | null {
  try {
    const saved = window.localStorage.getItem(key(workspaceId));
    return saved === "plan" || saved === "build" ? saved : null;
  } catch {
    return null;
  }
}

export function rememberMode(workspaceId: string, mode: SessionMode): void {
  try {
    window.localStorage.setItem(key(workspaceId), mode);
  } catch {
    // Blocked storage costs a local session its mode on the next open.
  }
}
