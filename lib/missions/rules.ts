/**
 * Missions and their Runners (docs/missions.md), the parts with no network:
 * the cap on a Mission's Runners, what a Runner's state is called, and how a
 * tool's arguments are read.
 */

import type { WorkspaceStatus } from "@/lib/runtime/types";

/** A Mission holds at most this many Runners that aren't archived; the
 *  database's trigger holds it to the same (20261102200000_missions.sql). */
export const MAX_RUNNERS = 20;

/** A Runner in one of these no longer takes a place under the cap. */
export const ENDED_STATUSES: readonly WorkspaceStatus[] = ["archived", "destroying", "destroyed", "failed"];

/** The notes' cap, as the table's check has it. */
export const NOTES_MAX_CHARS = 65536;

/** Where the Mission's notes are laid on its box, in its worktree: `.context`
 *  is the gitignored folder every session has for its own files. */
export const NOTES_FILE = ".context/mission-notes.md";

export function isLiveRunner(runner: { status: WorkspaceStatus }): boolean {
  return !ENDED_STATUSES.includes(runner.status);
}

/** How many more Runners the Mission may start. */
export function runnerPlacesLeft(runners: readonly { status: WorkspaceStatus }[]): number {
  return Math.max(0, MAX_RUNNERS - runners.filter(isLiveRunner).length);
}

/** A Runner's state as the Mission's tools and its Runners pane say it. */
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

/** What a Runner is told when it starts in plan mode, before its brief: the
 *  Mission reads the plan, then says go (message_runner). */
export const PLAN_MODE_PREFIX =
  "Plan mode: read what you need, then reply with your plan and end your turn. Don't change any files until you're told to go ahead.\n\n";
