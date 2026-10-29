/**
 * What's worth telling someone about their session, Replicas' way: its turn
 * finished, it needs their input (a question, a plan to approve, secrets), it
 * errored, or its pull request opened or merged. Worked out from what the
 * server's watch saw change (lib/session/watch.ts) and what GitHub said of
 * the pull request (lib/session/pull-request-state.ts); recorded once each
 * by its event key (lib/notifications/record.ts) and delivered from there.
 *
 * Pure, so the rules are unit-tested in Node.
 */

import type { TurnState } from "@/lib/session/turn-state";

export const NOTIFICATION_KINDS = ["turn_done", "needs_input", "errored", "pr_opened", "pr_merged", "pr_ready"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** Each kind as Settings names it. */
export const KIND_LABEL: Record<NotificationKind, string> = {
  turn_done: "A turn finishes",
  needs_input: "A session needs your input",
  errored: "A session errors",
  pr_opened: "A pull request opens",
  pr_merged: "A pull request merges",
  pr_ready: "A Ship's pull request is ready to review",
};

/**
 * Whether news is a Runner's to hear rather than the user's (docs/missions.md).
 * A Ship's own news (its turns, its questions, its pull requests, its
 * failures) reaches its Runner, which handles it and tells the user what
 * needs them. A Runner's turns end on its Ships' news all day: those
 * aren't told either. What's left for the user is a Runner that needs them
 * (needs_input, errored) and its Ships' pull requests ready (pr_ready).
 */
export function missionsQuiet(
  kind: NotificationKind,
  session: { kind?: "session" | "mission" | null; parentMissionId?: string | null },
): boolean {
  if (session.parentMissionId) return true;
  if (session.kind === "mission") return kind === "turn_done" || kind === "pr_opened" || kind === "pr_merged";
  return false;
}

/** A notification before it's recorded: whose, about which session, and what
 *  to say. `title` is the session's; `body` the news. */
export type NotificationDraft = {
  userId: string;
  workspaceId: string;
  kind: NotificationKind;
  eventKey: string;
  title: string;
  body: string;
};

/** News older than this when it's seen isn't worth telling (a box restored
 *  and its log read again from the start, or a tick catching up). */
export const STALE_AFTER_MS = 30 * 60_000;

const WAITING_BODY: Record<NonNullable<TurnState["waiting"]>, string> = {
  question: "Asked you a question",
  plan: "Waiting for you to approve its plan",
  secrets: "Waiting for secrets",
};

function fresh(at: string | null, now: number): boolean {
  const t = at ? Date.parse(at) : NaN;
  return !Number.isNaN(t) && now - t < STALE_AFTER_MS;
}

/**
 * What a read of a session's stream changed that's news: a wait that began,
 * or a turn that ended in a reply (with nothing left waiting). A session read
 * for the first time tells nothing: what it did before is history.
 */
export function activityNews(
  change: { before: TurnState | null; after: TurnState },
  session: { userId: string; workspaceId: string; title: string },
  now: number,
): NotificationDraft[] {
  const { before, after } = change;
  if (!before) return [];
  const draft = (kind: NotificationKind, eventKey: string, body: string): NotificationDraft => ({
    ...session,
    kind,
    eventKey,
    body,
  });
  if (after.waiting && after.waitingToolId && after.waitingToolId !== before.waitingToolId && fresh(after.waitingSince, now)) {
    return [draft("needs_input", after.waitingToolId, WAITING_BODY[after.waiting])];
  }
  if (
    after.turn === "idle" &&
    !after.waiting &&
    after.repliedAt &&
    after.repliedAt !== before.repliedAt &&
    fresh(after.repliedAt, now)
  ) {
    return [draft("turn_done", after.repliedAt, after.replyPreview || "Finished its turn")];
  }
  return [];
}

/** A pull request that opened, or opened again after closing (reopened, or
 *  a new one on the branch replacing a closed one), is news; one merged is
 *  too; one closed unmerged isn't. */
export function pullRequestNews(
  change: { from: "open" | "closed" | "merged" | null; to: "open" | "closed" | "merged"; number: number },
  session: { userId: string; workspaceId: string; title: string },
): NotificationDraft[] {
  if (change.to === "merged" && change.from !== "merged") {
    return [{ ...session, kind: "pr_merged", eventKey: String(change.number), body: `Pull request #${change.number} merged` }];
  }
  if (change.to === "open" && change.from !== "open" && change.from !== "merged") {
    // Its first opening keyed by its number; a reopening has a key of its
    // own, so it isn't taken for the opening told before (told once a pull
    // request: a second reopen of the same one is quiet).
    const reopened = change.from === "closed";
    return [
      {
        ...session,
        kind: "pr_opened",
        eventKey: reopened ? `${change.number}:reopened` : String(change.number),
        body: `Pull request #${change.number} ${reopened ? "reopened" : "opened"}`,
      },
    ];
  }
  return [];
}

/** A session whose setup or run failed: news once per failure. */
export function errorNews(
  session: { userId: string; workspaceId: string; title: string; failedAt: string; message: string | null },
): NotificationDraft {
  return {
    userId: session.userId,
    workspaceId: session.workspaceId,
    title: session.title,
    kind: "errored",
    eventKey: session.failedAt,
    body: session.message ? `Errored: ${session.message}` : "Errored",
  };
}

/** How someone wants to hear (notification_preferences). */
export type NotificationPreferences = {
  browser: boolean;
  email: "off" | "instant" | "digest";
  slack: boolean;
  kinds: NotificationKind[];
};

/** Browser on, email and Slack off, every kind: until someone says otherwise. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  browser: true,
  email: "off",
  slack: false,
  kinds: [...NOTIFICATION_KINDS],
};

/** How long after a notification email and Slack wait: seen in the app by
 *  then, it isn't sent at all. */
export const DELIVERY_GRACE_MS = 60_000;

/**
 * Whether email or Slack should carry a notification now: the person wants
 * that kind, it's past the grace, and they haven't looked at the session
 * since it happened.
 */
export function dueFor(
  notification: { kind: NotificationKind; createdAt: string },
  preferences: Pick<NotificationPreferences, "kinds">,
  seenAt: string | null,
  now: number,
): "send" | "wait" | "skip" {
  if (!preferences.kinds.includes(notification.kind)) return "skip";
  const created = Date.parse(notification.createdAt);
  if (seenAt && Date.parse(seenAt) >= created) return "skip";
  return now - created >= DELIVERY_GRACE_MS ? "send" : "wait";
}
