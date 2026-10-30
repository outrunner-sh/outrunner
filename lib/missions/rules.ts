/**
 * Mission and Ship rules (docs/missions.md), the parts with no network: the cap
 * on a Mission's Ships, what a Ship's state is called, and how a
 * tool's arguments are read.
 */

import type { WorkspaceStatus } from "@/lib/runtime/types";

/** A Mission holds at most this many Ships that aren't archived; the
 *  database's trigger holds it to the same (20261102200000_missions.sql). */
export const MAX_RUNNERS = 20;

/** A Ship in one of these no longer takes a place under the cap. */
export const ENDED_STATUSES: readonly WorkspaceStatus[] = ["archived", "destroying", "destroyed", "failed"];

/** The notes' cap, as the table's check has it. */
export const NOTES_MAX_CHARS = 65536;

/** Where the Mission's notes are laid on its box, in its worktree: `.context`
 *  is the gitignored folder every session has for its own files. */
export const NOTES_FILE = ".context/mission-notes.md";

export function isLiveRunner(runner: { status: WorkspaceStatus }): boolean {
  return !ENDED_STATUSES.includes(runner.status);
}

/** How many more Ships the Mission may start. */
export function runnerPlacesLeft(runners: readonly { status: WorkspaceStatus }[]): number {
  return Math.max(0, MAX_RUNNERS - runners.filter(isLiveRunner).length);
}

/** A Ship's state as the Mission's tools and Ships pane say it. */
export type RunnerState = "setting_up" | "working" | "idle" | "asleep" | "archived" | "failed" | "gone";

export function runnerState(status: WorkspaceStatus, working: boolean): RunnerState {
  switch (status) {
    case "creating":
    case "provisioning":
      return "setting_up";
    case "ready":
    case "idle":
      return working ? "working" : "idle";
    case "suspending":
    case "suspended":
    case "resuming":
      return "asleep";
    case "archiving":
    case "archived":
    case "restoring":
      return "archived";
    case "failed":
      return "failed";
    default:
      return "gone";
  }
}

/** A tool argument read as text: trimmed, or undefined when absent or blank. */
export function textArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function boolArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

/** A Mission's name from its first message: its first sentence, short, cut
 *  at a word. A session's title can be its whole first line; a Mission sits
 *  in the sidebar for weeks, so it gets a name. */
export function missionName(prompt: string): string {
  // Its first line that says something, then that line's first sentence: a
  // heading-style first line is the name it was given.
  const firstLine = prompt.split("\n").find((line) => line.replace(/[`*_#>\s]/g, "")) ?? "";
  const plain = firstLine.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = plain.split(/(?<=[.!?:;])\s/)[0]?.replace(/[.!?:;,]+$/, "") ?? "";
  if (sentence.length <= 48) return sentence || "New Mission";
  const cut = sentence.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 48).trim()}…`;
}
