/**
 * A Runner's turns, watched for their end (lib/session/turn-watch.ts) so its
 * Mission hears once each: `finished` with its reply, or `needs_attention`
 * with why when it can't end (its setup failed, its agent exited, its box
 * died). A watch opens with each send to the Runner (its brief, the Mission's
 * messages, a queued one going) and lives in turn_watches, looked at right
 * after the send and then by the tick, so a restart or the box sleeping
 * loses nothing. When a turn ends, the next message queued for it goes.
 */

import { eventKey, type MissionEventKind, type MissionEventPayload } from "@/lib/missions/events";
import { observeTurn, type TurnObservation, type WatchState } from "@/lib/session/turn-watch";
import type { Workspace } from "@/lib/runtime/types";

export type WatchRow = {
  workspaceId: string;
  sentAt: string;
  baselineActivity: string | null;
  seenWorking: boolean;
  quietSince: string | null;
  quietActivity: string | null;
  lastMessage: string | null;
  unreachableSince: string | null;
  exitedSince?: string | null;
  upSince?: string | null;
};

export type RecordedEvent = {
  missionId: string;
  runnerId: string;
  kind: MissionEventKind;
  payload: MissionEventPayload;
  key: string;
};

export type WatchDeps = {
  session(id: string): Promise<Workspace | null>;
  look(session: Workspace): Promise<Pick<TurnObservation, "reachable" | "working" | "waiting" | "waitingToolId" | "summary">>;
  save(row: WatchRow): Promise<void>;
  /** Close the watch on the turn sent at `sentAt`: one a send since opened
   *  is another turn's, and stays. */
  close(workspaceId: string, sentAt: string): Promise<void>;
  /** Record the event once (its key); true when it's new. */
  record(event: RecordedEvent): Promise<boolean>;
  /** The Runner's next queued message, taken; null when none waits. */
  takeQueued(runnerId: string): Promise<{ id: string; content: string } | null>;
  returnQueued(id: string): Promise<void>;
  /** Send to the Runner (waking it), and open a watch on that turn. */
  sendAndWatch(runner: Workspace, content: string): Promise<boolean>;
  now(): number;
};

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());

function toState(row: WatchRow): WatchState {
  return {
    sentAt: Date.parse(row.sentAt),
    baselineActivity: ms(row.baselineActivity),
    seenWorking: row.seenWorking,
    quietSince: ms(row.quietSince),
    quietActivity: row.quietActivity,
    lastMessage: row.lastMessage,
    unreachableSince: ms(row.unreachableSince),
    exitedSince: ms(row.exitedSince ?? null),
    upSince: ms(row.upSince ?? null),
  };
}

export type WatchOutcome = "waiting" | "finished" | "needs_attention" | "closed";

/** How a Ship waiting on a person is described to its Runner. */
const WAITING_REASON = {
  question: "it asked a question only a person can answer: open the Ship to answer it",
  plan: "it's waiting for its plan to be approved: open the Ship to approve it",
  secrets: "it's waiting for secrets: open the Ship to provide them",
} as const;

/** Look at one watched turn, and act on what's seen. */
export async function checkRunnerWatch(row: WatchRow, deps: WatchDeps): Promise<WatchOutcome> {
  const runner = await deps.session(row.workspaceId);
  const missionId = runner?.parentMissionId;
  if (!runner || !missionId) {
    await deps.close(row.workspaceId, row.sentAt);
    return "closed";
  }
  const now = deps.now();
  const up = runner.status === "ready" || runner.status === "idle";
  const look = up ? await deps.look(runner) : { reachable: false, working: null, summary: null };
  const verdict = observeTurn(toState(row), { now, status: runner.status, errorMessage: runner.errorMessage, ...look });
  const name = runner.title ?? runner.branch;
  switch (verdict.kind) {
    case "waiting": {
      const s = verdict.state;
      await deps.save({
        ...row,
        seenWorking: s.seenWorking,
        quietSince: iso(s.quietSince),
        quietActivity: s.quietActivity,
        lastMessage: s.lastMessage,
        unreachableSince: iso(s.unreachableSince),
        exitedSince: iso(s.exitedSince ?? null),
        upSince: iso(s.upSince ?? null),
      });
      return "waiting";
    }
    case "closed":
      await deps.close(row.workspaceId, row.sentAt);
      return "closed";
    case "waiting_on_user": {
      // Told once a wait (its call's id); the watch stays open for the turn's
      // end once someone answers.
      await deps.record({
        missionId,
        runnerId: runner.id,
        kind: "needs_attention",
        payload: { runner: name, reason: WAITING_REASON[verdict.waiting] },
        key: eventKey.needsAttention(runner.id, "waiting", verdict.toolId),
      });
      const s = verdict.state;
      await deps.save({
        ...row,
        seenWorking: s.seenWorking,
        quietSince: null,
        quietActivity: null,
        lastMessage: s.lastMessage,
        unreachableSince: null,
        exitedSince: iso(s.exitedSince ?? null),
        upSince: iso(s.upSince ?? null),
      });
      return "needs_attention";
    }
    case "lost":
      await deps.record({
        missionId,
        runnerId: runner.id,
        kind: "needs_attention",
        payload: { runner: name, reason: verdict.cause },
        key: eventKey.needsAttention(runner.id, "turn", row.sentAt),
      });
      await deps.close(row.workspaceId, row.sentAt);
      return "needs_attention";
    case "over": {
      await deps.record({
        missionId,
        runnerId: runner.id,
        kind: "finished",
        payload: { runner: name, response: verdict.message, ...(verdict.asleep && { asleep: true }) },
        key: eventKey.finished(runner.id, row.sentAt),
      });
      await deps.close(row.workspaceId, row.sentAt);
      await sendNextQueued(runner, deps);
      return "finished";
    }
  }
}

/** The Runner's next queued message, sent now that its turn is over; given
 *  back if it didn't go, for the tick to try again. */
export async function sendNextQueued(runner: Workspace, deps: Pick<WatchDeps, "takeQueued" | "returnQueued" | "sendAndWatch">): Promise<boolean> {
  const next = await deps.takeQueued(runner.id);
  if (!next) return false;
  if (await deps.sendAndWatch(runner, next.content).catch(() => false)) return true;
  await deps.returnQueued(next.id);
  return false;
}
