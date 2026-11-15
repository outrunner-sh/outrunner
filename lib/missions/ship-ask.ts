/**
 * A Ship's question answered from Slack (docs/missions.md, "Ships' questions
 * in Slack"). A Ship started for a Slack request that waits on its
 * `ask_user` call gets a card in that request's thread: what it's working
 * on, the question, a button an option, and "Other" linking to the Ship.
 * The card names the exact call (callId, launchEpoch, #421's identity), and
 * a click answers that call only (lib/runtime/answer-question.ts), never a
 * newer one asking the same.
 *
 *   posting   the Runner watch (lib/missions/watch.ts) sees the Ship wait on
 *             a question; one card a call, keyed by its identity, through
 *             the post queue (its recheck: binding revision, mute,
 *             requester). A re-read of the same wait posts nothing more.
 *   clicking  the gate of a request (a linked account in the Mission's org
 *             with read on its project); the first click is claimed, then
 *             delivered; the card then says who picked what.
 *   stale     a card of another binding, or whose call is over (answered in
 *             Outrunner, the Ship ended or moved on), answers nothing: the
 *             click hears "No longer waiting". The watch closes a card whose
 *             call it sees is over.
 *
 * The parts with no network; the wiring is ship-ask.deps.ts.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import type { QueueOutcome, QueuedPost } from "@/lib/missions/slack-outbox";
import type { Requester } from "@/lib/missions/slack-route";
import type { MissionChannel, MissionThread, NewShipAsk, ShipAsk, ShipLedger } from "@/lib/missions/slack-store";
import { parseShipAskValue, shipAnsweredBlocks, shipAskBlocks, shipClosedBlocks } from "@/lib/missions/slack-text";
import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { AnswerOutcome } from "@/lib/runtime/answer-question";
import { CANT_NAME_CALLS_MESSAGE } from "@/lib/runtime/answer-question";
import type { PendingQuestionSummary } from "@/lib/runtime/agent-protocol";
import type { Workspace } from "@/lib/runtime/types";

/** What a click hears when the card's call isn't waiting any more. */
export const SHIP_ASK_STALE = "No longer waiting: that question was answered, or the Ship moved on.";
/** ...and when the card is of a binding that's over. */
export const SHIP_ASK_OFF_CALL = "No longer waiting: the Mission went off call (or was put on call again) since it was asked.";
export const SHIP_ASK_NO_ACCESS = "Only people who can read this Mission's project in Outrunner can answer it.";

/** The most buttons a card has; a question with more links to the Ship. */
export const MAX_SHIP_ASK_OPTIONS = 10;

/** One card a call: the Ship and the call's identity. Hashed, as callId and
 *  launchEpoch are each up to 200 characters. */
export function shipAskKey(runnerId: string, call: { callId: string; launchEpoch: string }): string {
  const digest = createHash("sha256").update(`${call.launchEpoch}\u0000${call.callId}`).digest("hex").slice(0, 32);
  return `ship_ask:${runnerId}:${digest}`;
}

/** The answer's operation id: one a card, so a retry, or a second click of
 *  the same option, is the agent's receipt, never a second delivery. */
export function shipAnswerOperation(askId: string): string {
  return `slack-ship-ask:${askId}`;
}

// The questions as the agent reads them (lib/runtime/pending-question.ts).
const AskOption = z.union([z.string().transform((label) => ({ label })), z.object({ label: z.string() })]);
const AskQuestions = z
  .array(z.object({ header: z.string().optional(), question: z.string(), options: z.array(AskOption).min(1), multiSelect: z.boolean().optional() }))
  .min(1)
  .max(4);

/** The card's question text, and its buttons: one an option where a single
 *  click answers it (one question, one pick), none otherwise. Null for
 *  questions the agent wouldn't take either. */
export function cardQuestion(raw: unknown): { question: string; options: string[] } | null {
  const parsed = AskQuestions.safeParse(raw);
  if (!parsed.success) return null;
  const qs = parsed.data;
  const question = qs
    .map((q) => (q.header?.trim() ? `*${q.header.trim().replace(/[*<>|]/g, "")}*  ${q.question}` : q.question))
    .join("\n\n")
    .slice(0, 2900);
  if (!question.trim()) return null;
  const one = qs.length === 1 && !qs[0].multiSelect ? qs[0].options.map((o) => o.label) : [];
  const clickable = one.length > 0 && one.length <= MAX_SHIP_ASK_OPTIONS && one.every((label) => label.trim() !== "" && label.length <= 500);
  return { question, options: clickable ? one : [] };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export type ShipAskPostDeps = {
  ledger(runnerId: string): Promise<ShipLedger | null>;
  binding(missionId: string): Promise<MissionChannel | null>;
  /** The card made for the transcript call the watch saw, if any. */
  existing(runnerId: string, toolUseId: string): Promise<ShipAsk | null>;
  /** Whether its post was queued (whatever came of it). */
  queued(opKey: string): Promise<boolean>;
  /** The calls the Ship's agent waits on (main chat); null when it can't
   *  name them (no AGENT_FEATURE_ASK_CALL_IDENTITY) or didn't answer. */
  pending(runner: Workspace): Promise<PendingQuestionSummary[] | null>;
  save(ask: NewShipAsk): Promise<ShipAsk>;
  queue(post: QueuedPost): Promise<QueueOutcome>;
  shipUrl(runnerId: string): string | null;
};

export type PostResult = "queued" | "exists" | "not_slack" | "off_call" | "muted" | "cant_name_calls" | "not_pending" | "unreadable";

/** The Ship's thread and the binding a card goes under: the Ship's own
 *  binding, which must still stand in that channel (a Ship of an earlier
 *  binding went on with its owner). */
async function shipPlace(runner: Workspace, deps: Pick<ShipAskPostDeps, "ledger" | "binding">): Promise<{ ledger: ShipLedger; thread: MissionThread; binding: MissionChannel } | "not_slack" | "off_call"> {
  const missionId = runner.parentMissionId;
  if (!missionId) return "not_slack";
  const ledger = await deps.ledger(runner.id);
  const thread = ledger?.thread;
  if (!ledger || !thread || thread.missionId !== missionId) return "not_slack";
  const binding = await deps.binding(missionId);
  if (!binding || binding.teamId !== thread.teamId || binding.channelId !== thread.channelId) return "off_call";
  if (ledger.bindingRevision && ledger.bindingRevision !== binding.revision) return "off_call";
  return { ledger, thread, binding };
}

function cardPost(ask: ShipAsk, place: { ledger: ShipLedger; thread: MissionThread; binding: MissionChannel }, url: string | null): QueuedPost {
  return {
    opKey: ask.opKey,
    missionId: ask.missionId,
    bindingRevision: ask.bindingRevision,
    teamId: place.thread.teamId,
    channelId: place.thread.channelId,
    threadTs: place.thread.threadTs,
    kind: "ask",
    payload: {
      text: `Working on: ${ask.title}. ${ask.question}`.slice(0, 3000),
      blocks: shipAskBlocks({ askId: ask.id, title: ask.title, question: ask.question, options: ask.options, url }),
      shipAskId: ask.id,
    },
    requester: place.ledger.requestedBy,
  };
}

/**
 * The Ship waits on its ask_user call `toolUseId` (the transcript's, as the
 * watch saw it): its card, queued once in its request's thread. Cheap when
 * there's nothing to do: a Ship with no Slack thread, a muted thread, or a
 * card already made, never asks the box.
 */
export async function postShipAsk(runner: Workspace, toolUseId: string, deps: ShipAskPostDeps): Promise<PostResult> {
  const place = await shipPlace(runner, deps);
  if (typeof place === "string") return place;
  if (place.thread.muted) return "muted";
  const made = await deps.existing(runner.id, toolUseId);
  if (made) {
    // Made, but its post never queued (a crash between the two): queue it now.
    if (made.bindingRevision !== place.binding.revision || (await deps.queued(made.opKey))) return "exists";
    return (await deps.queue(cardPost(made, place, deps.shipUrl(runner.id)))) === "queued" ? "queued" : "exists";
  }
  const waiting = await deps.pending(runner);
  if (!waiting) return "cant_name_calls";
  // The call the watch saw, where the agent tied it to the transcript; one
  // it hasn't tied yet is the call, if it's the only one.
  const call = waiting.find((q) => q.toolUseId === toolUseId) ?? (waiting.length === 1 && waiting[0].toolUseId === undefined ? waiting[0] : null);
  if (!call) return "not_pending";
  const card = cardQuestion(call.questions);
  if (!card) return "unreadable";
  const ask = await deps.save({
    missionId: place.binding.missionId,
    runnerId: runner.id,
    threadId: place.thread.id,
    bindingRevision: place.binding.revision,
    opKey: shipAskKey(runner.id, call),
    callId: call.callId,
    launchEpoch: call.launchEpoch,
    toolUseId,
    title: (runner.title ?? runner.branch).replace(/\s+/g, " ").trim().slice(0, 300) || "Ship",
    question: card.question,
    options: card.options,
    questions: call.questions,
  });
  // Saved before under the key (the same call seen again): its post stands.
  if (ask.toolUseId !== toolUseId && (await deps.queued(ask.opKey))) return "exists";
  const outcome = await deps.queue(cardPost(ask, place, deps.shipUrl(runner.id)));
  return outcome === "queued" ? "queued" : "exists";
}

// ---------------------------------------------------------------------------
// Closing cards whose call is over
// ---------------------------------------------------------------------------

export type ShipAskSettleDeps = {
  open(runnerId: string): Promise<ShipAsk[]>;
  /** Close an unanswered card; true when this closed it. */
  close(askId: string): Promise<boolean>;
  thread(id: string): Promise<MissionThread | null>;
  /** Replace a card's message. */
  edit(teamId: string, channelId: string, ts: string, text: string, blocks: Record<string, unknown>[]): Promise<void>;
};

/**
 * The Ship isn't waiting on these calls any more (answered in Outrunner, it
 * went on, ended or asked something else): every open card of it but the
 * call it still waits on (`keepToolUseId`) is closed, and says so. A card
 * claimed by a Slack click is left to that click.
 */
export async function settleShipAsks(runnerId: string, keepToolUseId: string | null, deps: ShipAskSettleDeps): Promise<number> {
  let closed = 0;
  for (const ask of await deps.open(runnerId)) {
    if (keepToolUseId !== null && ask.toolUseId === keepToolUseId) continue;
    if (!(await deps.close(ask.id))) continue;
    closed++;
    if (!ask.messageTs) continue;
    const thread = await deps.thread(ask.threadId).catch(() => null);
    if (!thread) continue;
    await deps.edit(thread.teamId, thread.channelId, ask.messageTs, `${ask.question}: no longer waiting`, shipClosedBlocks(ask.title, ask.question, "moved_on")).catch(() => undefined);
  }
  return closed;
}

// ---------------------------------------------------------------------------
// A click
// ---------------------------------------------------------------------------

export type ShipAskClick = { teamId: string; user: string; value: string; channel: string | null; messageTs?: string | null };

export type ShipAskClickDeps = {
  ask(id: string): Promise<ShipAsk | null>;
  thread(id: string): Promise<MissionThread | null>;
  binding(missionId: string): Promise<MissionChannel | null>;
  mission(id: string): Promise<Workspace | null>;
  runner(id: string): Promise<Workspace | null>;
  linked(slackUserId: string): Promise<Requester | null>;
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
  claim(askId: string, answer: { text: string; userId: string; slackUserId: string }): Promise<boolean>;
  release(askId: string, slackUserId: string): Promise<void>;
  /** Close the card; `claimedBy`: the claim of an answer the agent refused. */
  close(askId: string, claimedBy?: string): Promise<boolean>;
  /** Deliver `label` to the card's exact call (deliverAnswer). */
  answer(runner: Workspace, ask: ShipAsk, label: string): Promise<AnswerOutcome>;
  /** After an answer went: watch the Ship's turn, as the app's answer route
   *  does, so its session shows as working again. Best effort. */
  sent?(runner: Workspace): void;
  name(slackUserId: string): Promise<string>;
  edit(teamId: string, channelId: string, ts: string, text: string, blocks: Record<string, unknown>[]): Promise<void>;
  /** Said to the person who clicked alone. */
  tell(channel: string, threadTs: string, text: string): Promise<void>;
  askToConnect(channel: string, threadTs: string): Promise<void>;
};

export type ClickResult = "answered" | "stale" | "refused" | "failed" | "ignored";

/** Session statuses whose call is over: nothing on the box waits now. */
const ENDED: ReadonlySet<Workspace["status"]> = new Set(["archiving", "archived", "destroying", "destroyed", "failed", "suspending", "suspended"]);

/** Handle the click; what happened, for the tests. */
export async function answerShipAsk(click: ShipAskClick, deps: ShipAskClickDeps): Promise<ClickResult> {
  const parsed = parseShipAskValue(click.value);
  if (!parsed) return "ignored";
  const ask = await deps.ask(parsed.askId);
  if (!ask) return "ignored";
  const [thread, binding] = await Promise.all([deps.thread(ask.threadId), deps.binding(ask.missionId)]);
  if (!thread || thread.missionId !== ask.missionId || thread.teamId !== click.teamId) return "ignored";
  if (click.channel && click.channel !== thread.channelId) return "ignored";
  const tell = (text: string) => deps.tell(thread.channelId, thread.threadTs, text).catch(() => undefined);
  const ts = ask.messageTs ?? click.messageTs ?? null;
  const closeCard = async (claimedBy?: string) => {
    if ((await deps.close(ask.id, claimedBy).catch(() => false)) && ts) {
      await deps.edit(thread.teamId, thread.channelId, ts, `${ask.question}: no longer waiting`, shipClosedBlocks(ask.title, ask.question, "moved_on")).catch(() => undefined);
    }
  };

  // A card of a binding that's over (off call, archived, on call again):
  // nothing waits on it here.
  if (!binding || binding.teamId !== thread.teamId || binding.channelId !== thread.channelId || binding.revision !== ask.bindingRevision) {
    await tell(SHIP_ASK_OFF_CALL);
    return "stale";
  }
  const requester = await deps.linked(click.user);
  if (!requester) {
    await deps.askToConnect(thread.channelId, thread.threadTs).catch(() => undefined);
    return "refused";
  }
  const mission = await deps.mission(ask.missionId);
  if (requester.orgId !== binding.orgId || !mission || !allows(await deps.level(requester.userId, mission), "read")) {
    await tell(SHIP_ASK_NO_ACCESS);
    return "refused";
  }
  const label = ask.options[parsed.option];
  if (label === undefined) return "ignored";
  if (ask.answeredAt || ask.closedAt) {
    await tell(SHIP_ASK_STALE);
    return "stale";
  }
  const runner = await deps.runner(ask.runnerId);
  if (!runner || runner.parentMissionId !== ask.missionId || ENDED.has(runner.status)) {
    await closeCard();
    await tell(SHIP_ASK_STALE);
    return "stale";
  }
  if (!(await deps.claim(ask.id, { text: label, userId: requester.userId, slackUserId: click.user }))) {
    await tell(SHIP_ASK_STALE);
    return "stale";
  }
  const outcome = await deps.answer(runner, ask, label).catch((error: unknown): AnswerOutcome => {
    console.error(`Ship ${ask.runnerId}: answering its question from Slack failed`, error);
    return { ok: false, status: 502, error: "Couldn't send your answer. Please try again." };
  });
  if (outcome.ok) {
    deps.sent?.(runner);
    const name = await deps.name(click.user).catch(() => click.user);
    if (ts) await deps.edit(thread.teamId, thread.channelId, ts, `${ask.question}: ${label}`, shipAnsweredBlocks(ask.title, ask.question, label, name)).catch(() => undefined);
    return "answered";
  }
  if (outcome.status === 409 && outcome.error !== CANT_NAME_CALLS_MESSAGE) {
    // The call is over: answered in Outrunner, given up, from before a
    // restart, or answered first with another pick.
    await closeCard(click.user);
    await tell(SHIP_ASK_STALE);
    return "stale";
  }
  await deps.release(ask.id, click.user).catch(() => undefined);
  await tell(outcome.error);
  return "failed";
}
