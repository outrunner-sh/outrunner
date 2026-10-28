/**
 * Where a session stands, the way Replicas' sidebar tells you where to jump in
 * next:
 *
 *   needs_you  the agent asked a question, waits for a plan's approval or for
 *              secrets, the session errored, or it is stuck
 *   working    the agent is mid-turn (or the session is setting up)
 *   in_review  its pull request is open
 *   done       its pull request merged, or it is idle with nothing pending
 *   backlog    quiet for three days, with no pull request
 *
 * Worked out on the server from what it records (session_activity, the pull
 * request's state, the user's marks), so every tab and the Mac app agree; the
 * browser only renders it. A move by hand ("Move to") holds until the session
 * needs you again after it.
 *
 * Pure, so the rules are unit-tested in Node.
 */

import type { WorkspacePullRequest, WorkspaceStatus } from "@/lib/runtime/types";
import type { TurnState, Waiting } from "@/lib/session/turn-state";
import { isSettingUp, SETUP_STALLS_AFTER_MS } from "@/lib/session/provisioning";

export const STANDINGS = ["needs_you", "working", "in_review", "done", "backlog"] as const;
export type Standing = (typeof STANDINGS)[number];

export function isStanding(value: unknown): value is Standing {
  return typeof value === "string" && (STANDINGS as readonly string[]).includes(value);
}

/** Each group's name, as the sidebar and the list head it. */
export const STANDING_LABEL: Record<Standing, string> = {
  needs_you: "Needs you",
  working: "Working",
  in_review: "In review",
  done: "Done",
  backlog: "Backlog",
};

/** Why a session needs you. */
export type NeedsYouReason = Waiting | "error" | "stuck";

export const REASON_LABEL: Record<NeedsYouReason, string> = {
  question: "Asked you a question",
  plan: "Waiting for its plan's approval",
  secrets: "Waiting for secrets",
  error: "Errored",
  stuck: "Stuck: nothing new for a while",
};

/** A turn with nothing new on its stream for this long is stuck (a permission
 *  prompt the stream doesn't show, or a box gone mid-turn). Long enough for a
 *  slow test suite. */
export const STUCK_AFTER_MS = 30 * 60_000;

/** Quiet this long with no pull request, a session is backlog. */
export const BACKLOG_AFTER_MS = 3 * 24 * 60 * 60_000;

/** What the server keeps of a session's agent (session_activity). */
export type SessionActivity = Pick<
  TurnState,
  "turn" | "turnStartedAt" | "waiting" | "waitingSince" | "repliedAt" | "replyPreview" | "eventAt"
> & {
  /** When the server started reading it: a reply from before isn't unread. */
  createdAt: string;
};

/** One person's marks on a session (session_marks). */
export type SessionMark = {
  pinnedAt: string | null;
  movedTo: Standing | null;
  movedAt: string | null;
  seenAt: string | null;
};

export type SessionStanding = {
  standing: Standing;
  /** Why it needs you; null in any other group. */
  reason: NeedsYouReason | null;
  /** Put in its group by hand. */
  moved: boolean;
  pinned: boolean;
  /** A reply the user hasn't seen. */
  unread: boolean;
  /** The last reply's opening words. */
  replyPreview: string | null;
  /** When it last did anything: the order within a group. */
  at: string;
};

export type StandingInput = {
  workspace: {
    status: WorkspaceStatus;
    createdAt: string;
    updatedAt: string;
    lastActiveAt: string | null;
  };
  activity: SessionActivity | null;
  pullRequest: Pick<WorkspacePullRequest, "state" | "stateAt"> | null;
  mark: SessionMark | null;
  now: number;
};

/** The statuses whose agent is up, whose turn and waiting count. A session
 *  paused, archived or gone is neither working nor waiting, whatever its
 *  stream last said. */
const LIVE: WorkspaceStatus[] = ["ready", "idle"];

export function sessionStanding({ workspace, activity, pullRequest, mark, now }: StandingInput): SessionStanding {
  const auto = automatic({ workspace, activity, pullRequest, now });
  const at = latest(workspace.lastActiveAt, activity?.eventAt, activity?.repliedAt, workspace.createdAt) ?? workspace.createdAt;
  // A move holds, unless the session came to need you since it was made.
  const movedAt = mark?.movedAt ? Date.parse(mark.movedAt) : NaN;
  const needsYouSinceMove =
    auto.standing === "needs_you" && !(Date.parse(auto.since ?? "") <= movedAt);
  const moved = Boolean(mark?.movedTo) && !needsYouSinceMove;
  const standing = moved ? (mark!.movedTo as Standing) : auto.standing;
  // Unread: a reply since the user last saw it, or since the server started
  // reading the session, so sessions from before don't all light up at once.
  const seen = latest(mark?.seenAt, activity?.createdAt);
  const unread = Boolean(activity?.repliedAt && (!seen || Date.parse(activity.repliedAt) > Date.parse(seen)));
  return {
    standing,
    reason: standing === "needs_you" && !moved ? auto.reason : null,
    moved,
    pinned: Boolean(mark?.pinnedAt),
    unread,
    replyPreview: activity?.replyPreview ?? null,
    at,
  };
}

function automatic({
  workspace,
  activity,
  pullRequest,
  now,
}: Omit<StandingInput, "mark">): { standing: Standing; reason: NeedsYouReason | null; since: string | null } {
  const needsYou = (reason: NeedsYouReason, since: string | null) => ({ standing: "needs_you" as const, reason, since });
  if (workspace.status === "failed") return needsYou("error", workspace.updatedAt);
  if (isSettingUp(workspace.status)) {
    const created = Date.parse(workspace.createdAt);
    // Set up for so long it never finished: shown failed on its page too.
    if (Number.isNaN(created) || now - created >= SETUP_STALLS_AFTER_MS) return needsYou("stuck", workspace.createdAt);
    return { standing: "working", reason: null, since: null };
  }
  const live = LIVE.includes(workspace.status) ? activity : null;
  if (live?.waiting) return needsYou(live.waiting, live.waitingSince);
  if (live?.turn === "working") {
    const last = latest(live.eventAt, live.turnStartedAt);
    if (last && now - Date.parse(last) >= STUCK_AFTER_MS) return needsYou("stuck", last);
    return { standing: "working", reason: null, since: null };
  }
  // Coming back: worked on again in a moment.
  if (workspace.status === "resuming" || workspace.status === "restoring") {
    return { standing: "working", reason: null, since: null };
  }
  if (pullRequest?.state === "merged") return { standing: "done", reason: null, since: null };
  if (pullRequest && (pullRequest.state ?? "open") === "open") return { standing: "in_review", reason: null, since: null };
  const quietSince = latest(workspace.lastActiveAt, activity?.eventAt, activity?.repliedAt, workspace.createdAt);
  if (!pullRequest && quietSince && now - Date.parse(quietSince) >= BACKLOG_AFTER_MS) {
    return { standing: "backlog", reason: null, since: null };
  }
  return { standing: "done", reason: null, since: null };
}

/** The latest of some times; null when none can be read. */
function latest(...times: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const time of times) {
    if (!time || Number.isNaN(Date.parse(time))) continue;
    if (!best || Date.parse(time) > Date.parse(best)) best = time;
  }
  return best;
}

/**
 * The next session that needs you after `current`, in the order the sidebar
 * lists them (pinned first, then most recent), wrapping round; null when none
 * does, or only the one on screen.
 */
export function nextNeedingYou(
  sessions: Array<{ id: string } & Pick<SessionStanding, "standing" | "pinned" | "at">>,
  current: string | undefined,
): string | null {
  const waiting = sortStandings(sessions.filter((s) => s.standing === "needs_you"));
  if (waiting.length === 0) return null;
  const here = waiting.findIndex((s) => s.id === current);
  const next = waiting[(here + 1) % waiting.length];
  return next.id === current ? null : next.id;
}

/** Pinned first, then most recent. */
export function sortStandings<T extends Pick<SessionStanding, "pinned" | "at">>(sessions: T[]): T[] {
  return sessions
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.at) - Date.parse(a.at));
}
