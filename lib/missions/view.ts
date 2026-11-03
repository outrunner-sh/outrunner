/**
 * A Runner as its owner sees it (the sidebar's Runners, the Ships pane): its
 * status, and its Ships grouped by what they wait on. The parts with no
 * network; lib/missions/view.deps.ts reads the rows.
 */

import type { RunnerState } from "@/lib/missions/rules";
import type { ProviderName } from "@/lib/runtime/types";
import { REASON_LABEL, type SessionStanding } from "@/lib/session/standing";

export type RunnerCheck = { name: string; status: string; conclusion: string | null; url: string | null };

export type RunnerPullView = {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  /** The settler's decision; null while it settles. */
  verdict: "ready" | "needs_attention" | null;
  reason: string | null;
  additions: number | null;
  deletions: number | null;
  checks: RunnerCheck[];
  reviewState: "approved" | "changes_requested" | "none" | null;
  mergeableState: string | null;
  /** When it merged or closed, for Shipping. */
  endedAt: string | null;
};

/** Where a Ship sits in the Ships pane. */
export type RunnerGroup = "needs_you" | "ready_to_merge" | "ready_to_review" | "working" | "shipping" | "done";

export const RUNNER_GROUPS: { key: Exclude<RunnerGroup, "done">; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "ready_to_merge", label: "Ready to merge" },
  { key: "ready_to_review", label: "Ready to review" },
  { key: "working", label: "Working" },
  { key: "shipping", label: "Shipping" },
];

export type RunnerView = {
  id: string;
  name: string;
  /** Its brief's first line. */
  summary: string;
  state: RunnerState;
  branch: string;
  pulls: RunnerPullView[];
  group: RunnerGroup;
  /** Why it needs someone, for Needs you. */
  attention: string | null;
  /** Where it stands as every session does (lib/session/standing.ts), for
   *  its mark and its unread reply; null before the server has read it. */
  standing: SessionStanding | null;
  createdAt: string;
};

export type MissionStatus = "needs_you" | "working" | "ready" | "idle";

export type MissionView = {
  id: string;
  title: string;
  icon: string | null;
  status: MissionStatus;
  /** Pull requests ready to merge or review. */
  readyCount: number;
  /** Ships that aren't archived. */
  liveRunners: number;
  environment: { id: string; name: string } | null;
  /** The project (repository) it was started in: its own session's. */
  projectId: string;
  /** Its own session's status (archived, asleep, …). */
  sessionStatus: string;
  /** Its own session's provider: whether it can be archived. */
  provider: ProviderName;
  /** Where its own session stands (lib/session/standing.ts). */
  standing: SessionStanding | null;
  runners: RunnerView[];
  createdAt: string;
};

/** Shipping shows a merged pull request this long. */
export const SHIPPING_MS = 24 * 60 * 60_000;

/** A brief's first line that says something, for a row. */
export function briefSummary(brief: string | null): string {
  if (!brief) return "";
  const lines = brief
    .replace(/^Plan mode:[^\n]*\n+/, "")
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s\d.]+/, "").trim())
    .filter(Boolean);
  const first = lines[0] ?? "";
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/** Where a Ship goes in the pane, and why it needs someone if it does. */
export function runnerGroup(
  runner: {
    state: RunnerState;
    pulls: readonly RunnerPullView[];
    lostCause: string | null;
    errorMessage: string | null;
    /** Where it stands as every session does: a question, a plan or
     *  secrets it waits on, an error, or stuck, is Needs you here too. */
    standing?: Pick<SessionStanding, "standing" | "reason"> | null;
  },
  now = Date.now(),
): { group: RunnerGroup; attention: string | null } {
  if (runner.state === "failed") return { group: "needs_you", attention: runner.errorMessage ?? "its setup failed" };
  if (runner.standing?.standing === "needs_you" && runner.standing.reason) {
    return { group: "needs_you", attention: REASON_LABEL[runner.standing.reason] };
  }
  const open = runner.pulls.filter((p) => p.state === "open");
  const blocked = open.find((p) => p.verdict === "needs_attention");
  if (blocked) return { group: "needs_you", attention: blocked.reason ?? "its pull request needs attention" };
  if (runner.lostCause && open.length === 0 && runner.state !== "archived") return { group: "needs_you", attention: runner.lostCause };
  const ready = open.filter((p) => p.verdict === "ready");
  if (ready.length > 0 && ready.length === open.length) {
    const mergeable = ready.every(
      (p) => p.reviewState === "approved" && (p.mergeableState === "clean" || p.mergeableState === "has_hooks"),
    );
    return { group: mergeable ? "ready_to_merge" : "ready_to_review", attention: null };
  }
  if (open.length > 0 || (runner.state !== "archived" && runner.state !== "gone")) return { group: "working", attention: null };
  const merged = runner.pulls.filter((p) => p.state === "merged" && p.endedAt && now - Date.parse(p.endedAt) < SHIPPING_MS);
  if (merged.length > 0) return { group: "shipping", attention: null };
  return { group: "done", attention: null };
}

/**
 * The Runner's status in the sidebar: it needs you only when its own
 * session does, as every session's standing says (it asked you through
 * ask_user, errored, or is stuck; a Ship that's stuck is the Runner's to
 * handle);
 * working while it or any Ship is at it, or a pull request is settling;
 * ready while a pull request waits on a review or a merge.
 */
export function missionStatus(input: {
  /** Where the Runner's own session stands. */
  standing: Pick<SessionStanding, "standing"> | null;
  runners: readonly Pick<RunnerView, "group" | "state" | "pulls">[];
}): MissionStatus {
  if (input.standing?.standing === "needs_you") return "needs_you";
  const settling = input.runners.some((r) => r.pulls.some((p) => p.state === "open" && p.verdict === null));
  const runnerWorking = input.runners.some((r) => r.state === "working" || r.state === "setting_up");
  if (input.standing?.standing === "working" || runnerWorking || settling) return "working";
  if (input.runners.some((r) => r.group === "ready_to_merge" || r.group === "ready_to_review")) return "ready";
  return "idle";
}

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  needs_you: "Needs you",
  working: "Working",
  ready: "Ready",
  idle: "Idle",
};

