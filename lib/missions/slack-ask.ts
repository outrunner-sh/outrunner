/**
 * A click on a Mission's question card (slack_ask, lib/missions/slack-tools.ts).
 * The same gate as a request (a linked account in the Mission's org that can
 * read its project); the first answer is claimed, reaches the Mission once as
 * a `slack_answer` event, and the card says who picked what. "Other" asks the
 * person to reply in the thread, which reaches the Mission as a request.
 */

import { eventKey } from "@/lib/missions/events";
import type { MissionAsk, MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { answeredBlocks, parseAskValue } from "@/lib/missions/slack-text";
import type { Requester } from "@/lib/missions/slack-route";
import type { RecordedEvent } from "@/lib/missions/watch";
import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

export type AskClick = { teamId: string; user: string; value: string; channel: string | null };

export type AskDeps = {
  ask(id: string): Promise<MissionAsk | null>;
  thread(id: string): Promise<MissionThread | null>;
  binding(missionId: string): Promise<MissionChannel | null>;
  mission(id: string): Promise<Workspace | null>;
  linked(slackUserId: string): Promise<Requester | null>;
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
  claim(askId: string, answer: { text: string; userId: string; slackUserId: string }): Promise<boolean>;
  enqueue(event: RecordedEvent): Promise<boolean>;
  name(slackUserId: string): Promise<string>;
  /** Replace the card. */
  update(binding: MissionChannel, ts: string, text: string, blocks: Record<string, unknown>[]): Promise<void>;
  tell(binding: MissionChannel, threadTs: string, text: string): Promise<void>;
  /** Said to the person who clicked, with no binding to say it under. */
  tellAt(channel: string, threadTs: string, text: string): Promise<void>;
  askToConnect(binding: MissionChannel, threadTs: string): Promise<void>;
};

/** Handle the click; what happened, for the tests. */
export async function answerAsk(click: AskClick, deps: AskDeps): Promise<"answered" | "other" | "refused" | "ignored"> {
  const parsed = parseAskValue(click.value);
  if (!parsed) return "ignored";
  const ask = await deps.ask(parsed.askId);
  if (!ask) return "ignored";
  const [thread, binding] = await Promise.all([deps.thread(ask.threadId), deps.binding(ask.missionId)]);
  if (!thread || thread.missionId !== ask.missionId || thread.teamId !== click.teamId) return "ignored";
  // A card of a binding that's over (the Mission went off call, was archived
  // or put on call again): nothing waits on it, and the click says so.
  const over = !binding || binding.teamId !== click.teamId || thread.channelId !== binding.channelId || (ask.createdAt && binding.boundAt && ask.createdAt < binding.boundAt);
  if (over) {
    if (!ask.answeredAt) await deps.tellAt(thread.channelId, thread.threadTs, "That question isn't waiting any more: the Mission went off call (or was put on call again) since it was asked.").catch(() => undefined);
    return "refused";
  }
  if (click.channel && click.channel !== binding.channelId) return "ignored";
  const requester = await deps.linked(click.user);
  if (!requester) {
    await deps.askToConnect(binding, thread.threadTs);
    return "refused";
  }
  const mission = await deps.mission(ask.missionId);
  if (requester.orgId !== binding.orgId || !mission || !allows(await deps.level(requester.userId, mission), "read")) {
    await deps.tell(binding, thread.threadTs, "Only people who can read this Mission's project in Outrunner can answer it.");
    return "refused";
  }
  if (ask.answeredAt) {
    await deps.tell(binding, thread.threadTs, "That question was answered already.");
    return "refused";
  }
  if (parsed.option === "other") {
    await deps.tell(binding, thread.threadTs, "Reply in this thread with your answer: the Mission reads it.");
    return "other";
  }
  const answer = ask.options[parsed.option];
  if (answer === undefined) return "ignored";
  if (!(await deps.claim(ask.id, { text: answer, userId: requester.userId, slackUserId: click.user }))) {
    await deps.tell(binding, thread.threadTs, "Someone answered that question first.");
    return "refused";
  }
  const name = await deps.name(click.user);
  await deps.enqueue({
    missionId: ask.missionId,
    runnerId: null,
    kind: "slack_answer",
    payload: {
      slack: { channel: binding.channelId, thread: thread.threadTs, author: name, slackUserId: click.user, userId: requester.userId, question: ask.question, answer },
    },
    key: eventKey.slackAnswer(ask.id),
  });
  if (ask.messageTs) await deps.update(binding, ask.messageTs, `${ask.question}: ${answer}`, answeredBlocks(ask.question, answer, name)).catch(() => undefined);
  return "answered";
}
