/**
 * A delegated session's turn, watched for its real end (lib/session/turn-watch.ts, as
 * Missions does), and what each look says in its tracker (a Linear activity, a Jira comment):
 *
 *   over              its reply, as a response, once
 *   lost              an error, with why and the session's link
 *   closed            a response: archived on purpose, so this stops
 *   waiting on someone   an elicitation, once a wait: a question is answered from the
 *                     tracker, a plan or secrets only from the session
 *   still working     Linear only: a thought, so it doesn't mark the session stale: its
 *                     latest message when that changed, otherwise "Still working."
 *   out of time       a response, with the link, rather than going quiet
 *
 * The parts with no network, so a tool running quietly can be tested: going quiet isn't
 * the end of a turn while its agent is mid-turn. Each thing said is claimed first, so an
 * overlapping watch and tick say it once, and given back if saying it failed.
 */

import { TrackerRefusedError } from "@/lib/trackers/errors";
import { createHash } from "node:crypto";

import { observeTurn, type TurnObservation, type WatchState } from "@/lib/session/turn-watch";
import type { WorkspaceStatus } from "@/lib/runtime/types";
import type { LinearActivity } from "@/lib/trackers/linear";

/** Linear marks a session stale after 30 minutes. The tick is every 2. */
export const THOUGHT_EVERY_MS = 15 * 60_000;
/** A thought is a line in Linear's view, not a place for a whole reply. */
const THOUGHT_MAX = 2000;

export const STILL_WORKING = "Still working.";

/** What's kept of a row for this. */
export type RelayRow = {
  agentSessionId: string;
  installationId: string;
  orgId: string | null;
  teamId: string | null;
  workspaceId: string | null;
  stage: string;
  relayUntil: number | null;
  relayedHash: string | null;
  watch: WatchState | null;
  lastSaidAt: number | null;
  saidHash: string | null;
};

export type RelayLook = Pick<TurnObservation, "reachable" | "working" | "waiting" | "waitingToolId" | "summary">;

export type RelayDeps = {
  trackerName: string;
  /** How often a working session says so. Null: it doesn't. */
  thoughtEveryMs: number | null;
  /** How to answer a question, where that isn't plain from the tracker itself. */
  questionHint: string | null;
  /** The longest message it can take, so what follows it (the link) isn't what's lost. */
  messageMax: number | null;
  /** How to bring back a session that was archived. */
  reviveHint: string;
  load(agentSessionId: string): Promise<RelayRow | null>;
  /** Whether the org it was asked through is still connected to that team. */
  connected(row: RelayRow): Promise<boolean>;
  session(workspaceId: string): Promise<{ status: WorkspaceStatus; errorMessage?: string | null } | null>;
  /** Only asked of a session that's up. */
  look(workspaceId: string): Promise<RelayLook>;
  /** Keep what's known, on the watch it read: a send since has opened a new one. */
  saveWatch(agentSessionId: string, sentAt: number, state: WatchState): Promise<void>;
  /** Take the end of this turn, closing the watch; false when it's been said. */
  claimFinal(agentSessionId: string, digest: string): Promise<boolean>;
  restoreFinal(agentSessionId: string, row: RelayRow): Promise<void>;
  /** Take this wait; false when it's been asked. */
  claimQuestion(agentSessionId: string, digest: string): Promise<boolean>;
  releaseQuestion(agentSessionId: string): Promise<void>;
  /** Take the next thought, unless one was said since `cutoff`. */
  claimThought(agentSessionId: string, cutoff: number, now: number, saidHash: string | null): Promise<boolean>;
  restoreThought(agentSessionId: string, previous: { lastSaidAt: number | null; saidHash: string | null }): Promise<void>;
  say(installationId: string, agentSessionId: string, content: LinearActivity): Promise<void>;
  /** Nothing more goes to Linear. A failed session's. */
  stop(agentSessionId: string): Promise<void>;
  sessionUrl(workspaceId: string): string;
  now(): number;
};

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What a wait on someone says, by what it waits for. Only a question can be answered from
 *  Linear: a plan is approved, and secrets are given, in the session. */
function askOf(waiting: string, message: string | null, link: string, hint: string | null): string {
  if (waiting === "plan") return `It's waiting for its plan to be approved.\n\n${link}`;
  if (waiting === "secrets") return `It's waiting for secrets.\n\n${link}`;
  return [message ?? "It's waiting on an answer.", hint, link].filter(Boolean).join("\n\n");
}

/** Look once. True when there's nothing left to watch; false to look again. */
export async function checkTurnRelay(agentSessionId: string, deps: RelayDeps): Promise<boolean> {
  try {
    return await lookOnce(agentSessionId, deps);
  } catch (error) {
    if (!(error instanceof TrackerRefusedError)) throw error;
    // The issue or its conversation is gone, or out of reach: it'd only be asked again until
    // the watch ran out.
    console.warn(`${deps.trackerName}: refused what a turn had to say, so nothing more goes there`, error);
    await deps.stop(agentSessionId);
    return true;
  }
}

async function lookOnce(agentSessionId: string, deps: RelayDeps): Promise<boolean> {
  const row = await deps.load(agentSessionId);
  if (!row?.workspaceId || row.stage !== "working" || row.relayUntil === null || !row.watch) return true;
  const { workspaceId } = row;
  // Disconnected, or the org's left: what it's doing is no longer anyone's to hear there.
  if (!(await deps.connected(row))) {
    await deps.stop(agentSessionId);
    return true;
  }
  const link = `[Open the session](${deps.sessionUrl(workspaceId)})`;
  const now = deps.now();
  const capped = (message: string) => (deps.messageMax !== null && message.length > deps.messageMax ? `${message.slice(0, deps.messageMax)}…` : message);

  const finish = async (content: LinearActivity): Promise<void> => {
    if (!(await deps.claimFinal(agentSessionId, hash(content.body)))) return;
    try {
      await deps.say(row.installationId, agentSessionId, content);
    } catch (error) {
      await deps.restoreFinal(agentSessionId, row);
      throw error;
    }
  };

  if (now >= row.relayUntil) {
    // The last it'll try: past this, nothing's watching for it to be said later.
    await finish({ type: "response", body: `This is running longer than Outrunner watches from ${deps.trackerName}, so no more replies will come here.\n\n${link}` }).catch(async (error: unknown) => {
      if (error instanceof TrackerRefusedError) throw error;
      console.warn(`${deps.trackerName}: couldn't say a watch ran out`, error);
      await deps.stop(agentSessionId);
    });
    return true;
  }

  const session = await deps.session(workspaceId);
  if (!session) {
    await finish({ type: "error", body: "The session is gone." });
    return true;
  }
  const up = session.status === "ready" || session.status === "idle";
  const look: RelayLook = up ? await deps.look(workspaceId) : { reachable: false, working: null, summary: null };
  const verdict = observeTurn(row.watch, { now, status: session.status, errorMessage: session.errorMessage, ...look });

  switch (verdict.kind) {
    case "over":
      await finish({ type: "response", body: verdict.message ? `${capped(verdict.message)}\n\n${link}` : `The turn ended with nothing to say.\n\n${link}` });
      return true;
    case "lost":
      // Said first: if it can't be, the next look says it, and only then does it stop.
      await finish({ type: "error", body: `The session stopped: ${verdict.cause}.\n\n${link}` });
      if (session.status === "failed") await deps.stop(agentSessionId);
      return true;
    case "closed":
      await finish({ type: "response", body: `The session was archived, so this stops here. ${deps.reviveHint}\n\n${link}` });
      return true;
    case "waiting_on_user": {
      await deps.saveWatch(agentSessionId, row.watch.sentAt, verdict.state);
      if (await deps.claimQuestion(agentSessionId, hash(verdict.toolId))) {
        try {
          await deps.say(row.installationId, agentSessionId, { type: "elicitation", body: askOf(verdict.waiting, verdict.state.lastMessage && capped(verdict.state.lastMessage), link, deps.questionHint) });
        } catch (error) {
          await deps.releaseQuestion(agentSessionId);
          throw error;
        }
      }
      return false;
    }
    case "waiting":
      await deps.saveWatch(agentSessionId, row.watch.sentAt, verdict.state);
      await sayProgress(row, verdict.state.lastMessage, now, deps);
      return false;
  }
}

async function sayProgress(row: RelayRow, lastMessage: string | null, now: number, deps: RelayDeps): Promise<void> {
  const every = deps.thoughtEveryMs;
  if (every === null || (row.lastSaidAt !== null && now - row.lastSaidAt < every)) return;
  const digest = lastMessage ? hash(lastMessage) : null;
  const fresh = digest !== null && digest !== row.saidHash;
  if (!(await deps.claimThought(row.agentSessionId, now - every, now, fresh ? digest : row.saidHash))) return;
  const body = fresh ? (lastMessage as string).slice(0, THOUGHT_MAX) : STILL_WORKING;
  try {
    await deps.say(row.installationId, row.agentSessionId, { type: "thought", body });
  } catch (error) {
    await deps.restoreThought(row.agentSessionId, { lastSaidAt: row.lastSaidAt, saidHash: row.saidHash });
    throw error;
  }
}
