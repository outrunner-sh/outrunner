/**
 * A Mission's Slack tools (docs/missions.md, "On call in Slack"):
 * slack_reply, slack_ask and slack_react, and what spawn_runner does for a
 * Mission on call (its limits, and the Ship's thread). The only way a Mission
 * talks in Slack, and only in a thread of its own bound channel: a thread of
 * another Mission, of another channel, or one muted, reads as no thread. No
 * other channel, no DMs.
 *
 * What touches the world comes in as `deps` (MissionSlackDeps, wired in
 * lib/missions/tools.deps.ts), so the scoping tests without Slack.
 */

import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { limitText, reactionName } from "@/lib/missions/slack-text";
import type { Workspace } from "@/lib/runtime/types";

export type MissionSlackDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  /** One of the Mission's threads by its ts, whatever its channel. */
  thread(missionId: string, threadTs: string): Promise<MissionThread | null>;
  /** Post Markdown in the thread (made mrkdwn, in chunks), or blocks. */
  post(binding: MissionChannel, threadTs: string, message: { markdown: string } | { text: string; blocks: Record<string, unknown>[] }): Promise<string | null>;
  react(binding: MissionChannel, ts: string, name: string): Promise<void>;
  saveAsk(input: { missionId: string; threadId: string; question: string; options: string[] }): Promise<string>;
  setAskMessage(askId: string, ts: string): Promise<void>;
  askBlocks(askId: string, question: string, options: string[]): Record<string, unknown>[];
  /** A place under the Mission's limits, or which said no. */
  reserveShip(missionId: string, thread: MissionThread | null): Promise<{ id: string } | { refused: "hour" | "day"; limit: number }>;
  linkShip(id: string, runnerId: string): Promise<void>;
  releaseShip(id: string): Promise<void>;
  /** The org's audit log: a Ship started from Slack. */
  auditShip(mission: Workspace, binding: MissionChannel, thread: MissionThread | null, runnerId: string): Promise<void>;
  /** Who asked in the thread, for the Ship's brief: their name, and the
   *  thread's link. */
  requester(thread: MissionThread): Promise<{ name: string; permalink: string | null }>;
};

export type ToolResult = { text: string; isError?: boolean };

const RUNNER_THREAD = {
  type: "string",
  description: "The thread a <slack_request> came from: its thread attribute (a Slack ts like 1731400000.123456).",
};

export const SLACK_TOOLS = [
  {
    name: "slack_reply",
    description:
      "Post in a thread of this Mission's Slack channel, the one a <slack_request> came from. Markdown, made Slack's mrkdwn; long text goes in several messages. The only way to talk in Slack: you can't post anywhere else or send DMs.",
    inputSchema: {
      type: "object",
      properties: { thread: RUNNER_THREAD, text: { type: "string", description: "What to say, in Markdown." } },
      required: ["thread", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_ask",
    description:
      "Ask a question in a thread as a card with buttons, plus Other (which asks people to reply in the thread). The first answer comes back to you as a <slack_answer> block. Use it when a request is ambiguous or needs a decision.",
    inputSchema: {
      type: "object",
      properties: {
        thread: RUNNER_THREAD,
        question: { type: "string", description: "The question, in Slack mrkdwn." },
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "1 to 5 short answers (up to 75 characters each)." },
      },
      required: ["thread", "question", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_react",
    description: 'Mark the thread\'s latest request with an emoji: "eyes" (taken on), "white_check_mark" (done) or "x" (failed).',
    inputSchema: {
      type: "object",
      properties: { thread: RUNNER_THREAD, emoji: { type: "string", enum: ["eyes", "white_check_mark", "x"] } },
      required: ["thread", "emoji"],
      additionalProperties: false,
    },
  },
] as const;

export const SLACK_TOOL_NAMES: readonly string[] = SLACK_TOOLS.map((t) => t.name);

function refuse(text: string): ToolResult {
  return { text, isError: true };
}

const NO_SUCH_THREAD = "This Mission has no such thread in its Slack channel. Use the thread attribute of the <slack_request> you're answering.";
const NOT_ON_CALL = "This Mission isn't on call in a Slack channel, so its Slack tools are off.";

/** The thread named, if it's this Mission's, in the channel it's on call in
 *  now; or why not. */
export async function scopedThread(
  mission: Workspace,
  threadTs: unknown,
  deps: MissionSlackDeps,
): Promise<{ binding: MissionChannel; thread: MissionThread } | { error: string }> {
  const binding = await deps.binding(mission.id);
  if (!binding) return { error: NOT_ON_CALL };
  if (typeof threadTs !== "string" || !/^\d{1,12}\.\d{1,8}$/.test(threadTs.trim())) return { error: NO_SUCH_THREAD };
  const thread = await deps.thread(mission.id, threadTs.trim());
  if (!thread || thread.missionId !== mission.id || thread.teamId !== binding.teamId || thread.channelId !== binding.channelId) {
    return { error: NO_SUCH_THREAD };
  }
  if (thread.muted) return { error: "That thread is muted (!mute): don't post there until someone says !unmute." };
  return { binding, thread };
}

/** Run one of the Slack tools for the Mission. */
export async function callSlackTool(mission: Workspace, name: string, args: Record<string, unknown>, deps: MissionSlackDeps | undefined): Promise<ToolResult> {
  if (!deps) return refuse(NOT_ON_CALL);
  const scoped = await scopedThread(mission, args.thread, deps);
  if ("error" in scoped) return refuse(scoped.error);
  const { binding, thread } = scoped;
  switch (name) {
    case "slack_reply": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return refuse("text is required.");
      if (text.length > 12000) return refuse("That's too long for a thread: keep it under 12000 characters.");
      await deps.post(binding, thread.threadTs, { markdown: text });
      return { text: "Posted." };
    }
    case "slack_ask": {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const options = Array.isArray(args.options)
        ? [...new Set(args.options.flatMap((o) => (typeof o === "string" && o.trim() ? [o.trim().slice(0, 75)] : [])))]
        : [];
      if (!question || question.length > 2900) return refuse("question is required, up to 2900 characters.");
      if (options.length < 1 || options.length > 5) return refuse("Give 1 to 5 options.");
      const askId = await deps.saveAsk({ missionId: mission.id, threadId: thread.id, question, options });
      const ts = await deps.post(binding, thread.threadTs, { text: question, blocks: deps.askBlocks(askId, question, options) });
      if (ts) await deps.setAskMessage(askId, ts);
      return { text: "Asked. The first answer comes back to you as a <slack_answer> block; end your turn until then." };
    }
    case "slack_react": {
      const emoji = typeof args.emoji === "string" ? reactionName(args.emoji) : null;
      if (!emoji) return refuse('emoji is one of "eyes", "white_check_mark" or "x".');
      await deps.react(binding, thread.lastRequestTs ?? thread.threadTs, emoji);
      return { text: "Done." };
    }
    default:
      return refuse(`No tool is called ${name}.`);
  }
}

/** For spawn_runner on a Mission on call: a place under its limits (every
 *  Ship it starts while on call counts, thread or not, as nothing proves one
 *  wasn't asked for in Slack), the thread it's for, and the requester named
 *  in its brief. A limit reached is said in the thread, so the requester
 *  hears it whatever the Mission does next. Null when it isn't on call. */
export async function slackSpawn(
  mission: Workspace,
  threadArg: unknown,
  deps: MissionSlackDeps | undefined,
): Promise<
  | null
  | { error: string }
  | { reservation: string; binding: MissionChannel; thread: MissionThread | null; briefNote: string | null }
> {
  if (!deps) return null;
  const binding = await deps.binding(mission.id);
  if (!binding) {
    return threadArg === undefined || threadArg === null || threadArg === "" ? null : { error: NOT_ON_CALL };
  }
  let thread: MissionThread | null = null;
  if (threadArg !== undefined && threadArg !== null && threadArg !== "") {
    const scoped = await scopedThread(mission, threadArg, deps);
    if ("error" in scoped) return { error: scoped.error };
    thread = scoped.thread;
  }
  const reserved = await deps.reserveShip(mission.id, thread);
  if ("refused" in reserved) {
    if (thread) await deps.post(binding, thread.threadTs, { markdown: limitText(reserved.refused, reserved.limit) }).catch(() => null);
    return {
      error: `The Ship didn't start: this Mission reached its limit on Ships started while on call (${reserved.limit} ${
        reserved.refused === "hour" ? "in an hour" : "in 24 hours"
      }).${thread ? " The thread was told; start nothing more for it." : " Tell the requester in their thread, and start nothing."}`,
    };
  }
  let briefNote: string | null = null;
  if (thread) {
    const who = await deps.requester(thread).catch(() => ({ name: "someone", permalink: thread?.permalink ?? null }));
    briefNote = `\n\n---\nRequested in Slack by ${who.name}${who.permalink ? ` (${who.permalink})` : ""}. In your pull request's description, say: "Requested by ${who.name} in Slack."`;
  }
  return { reservation: reserved.id, binding, thread, briefNote };
}
