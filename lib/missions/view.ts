/**
 * A Mission as its owner sees it (the sidebar's Missions, the Runners pane):
 * its status, and its Runners grouped by what they wait on. The parts with no
 * network; lib/missions/view.deps.ts reads the rows.
 */

import type { RunnerState } from "@/lib/missions/rules";

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

/** Where a Runner sits in the Runners pane. */
export type RunnerGroup = "needs_you" | "ready_to_merge" | "ready_to_review" | "working" | "shipping" | "done";

export const RUNNER_GROUPS: { key: Exclude<RunnerGroup, "done">; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "ready_to_merge", label: "Ready to merge" },
  { key: "ready_to_review", label: "Ready to review" },
  { key: "working", label: "Runners working" },
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
  /** Runners that aren't archived. */
  liveRunners: number;
  environment: { id: string; name: string } | null;
  /** Its own session's status (archived, asleep, …). */
  sessionStatus: string;
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

/** Where a Runner goes in the pane, and why it needs someone if it does. */
export function runnerGroup(
  runner: { state: RunnerState; pulls: readonly RunnerPullView[]; lostCause: string | null; errorMessage: string | null },
  now = Date.now(),
): { group: RunnerGroup; attention: string | null } {
  if (runner.state === "failed") return { group: "needs_you", attention: runner.errorMessage ?? "its setup failed" };
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
 * The Mission's status in the sidebar: it needs you only when it asks you
 * something itself (a Runner that's stuck is the Mission's to handle);
 * working while it or any Runner is at it, or a pull request is settling;
 * ready while a pull request waits on a review or a merge.
 */
export function missionStatus(input: {
  asking: boolean;
  working: boolean;
  runners: readonly Pick<RunnerView, "group" | "state" | "pulls">[];
}): MissionStatus {
  if (input.asking) return "needs_you";
  const settling = input.runners.some((r) => r.pulls.some((p) => p.state === "open" && p.verdict === null));
  const runnerWorking = input.runners.some((r) => r.state === "working" || r.state === "setting_up");
  if (input.working || runnerWorking || settling) return "working";
  if (input.runners.some((r) => r.group === "ready_to_merge" || r.group === "ready_to_review")) return "ready";
  return "idle";
}

/** Whether the Mission's last reply asks the user something: it ends on a
 *  question, and the Mission isn't still at work. */
export function asksUser(lastReply: string | null, working: boolean): boolean {
  if (working || !lastReply) return false;
  const tail = lastReply.trim().split("\n").filter(Boolean).pop() ?? "";
  return /\?\s*[*_`)]*$/.test(tail);
}

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  needs_you: "Needs you",
  working: "Working",
  ready: "Ready",
  idle: "Idle",
};

/** What changed between two looks that the user should hear about: pull
 *  requests that became ready, and Missions that came to need them. */
export function newsBetween(
  before: readonly MissionView[] | null,
  after: readonly MissionView[],
): { kind: "ready" | "needs_you"; missionId: string; mission: string; runnerId?: string; runner?: string; pr?: { number: number; title: string; url: string } }[] {
  if (!before) return [];
  const news: ReturnType<typeof newsBetween> = [];
  const was = new Map(before.map((m) => [m.id, m]));
  for (const mission of after) {
    const old = was.get(mission.id);
    if (!old) continue;
    if (mission.status === "needs_you" && old.status !== "needs_you") {
      news.push({ kind: "needs_you", missionId: mission.id, mission: mission.title });
    }
    const readyBefore = new Set(
      old.runners.flatMap((r) => r.pulls.filter((p) => p.state === "open" && p.verdict === "ready").map((p) => `${p.repo}#${p.number}`)),
    );
    for (const runner of mission.runners) {
      for (const pr of runner.pulls) {
        if (pr.state === "open" && pr.verdict === "ready" && !readyBefore.has(`${pr.repo}#${pr.number}`)) {
          news.push({
            kind: "ready",
            missionId: mission.id,
            mission: mission.title,
            runnerId: runner.id,
            runner: runner.name,
            pr: { number: pr.number, title: pr.title, url: pr.url },
          });
        }
      }
    }
  }
  return news;
}
