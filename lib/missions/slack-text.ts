/**
 * A Mission on call in Slack, the parts with no network: the exact commands
 * people give it (parsed here, never by a model, as `share channel access`
 * is: lib/slack/channel-access.ts), the thread keywords, and what the system
 * itself posts (the intro, the question card, a Ship's pull request, a limit
 * reached).
 */

import type { PullRequestRef } from "@/lib/missions/events";
import { pullRequestLink } from "@/lib/slack/announce-pull-request";

export type OnCallCommand =
  | { action: "bind"; project: string }
  | { action: "unbind" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "stop" }
  | { action: "help" };

export const ON_CALL_HELP =
  "To put a Mission on call here: `@Outrunner be on call here for <project>` (it needs write on the project). Then mention me with a task. In its threads: `!aside` keeps a message from it, `!mute` / `!unmute` silences the thread, `@Outrunner stop` stops its turn. `@Outrunner pause` / `resume` pauses it here, `@Outrunner stop being on call here` takes it off.";

/** The message without the bot's mention, trimmed. */
export function withoutMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), "").trim();
}

/** An exact on-call command, or null for anything else (a task). */
export function onCallCommand(text: string, botUserId: string): OnCallCommand | null {
  const clean = withoutMention(text, botUserId).replace(/[.!]+$/, "").trim();
  const bind = /^be on call here for\s+(.+)$/i.exec(clean);
  if (bind) {
    const project = bind[1].trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
    return project && project.length <= 200 ? { action: "bind", project } : { action: "help" };
  }
  if (/^be on call here$/i.test(clean)) return { action: "help" };
  if (/^(stop being on call here|go off call)$/i.test(clean)) return { action: "unbind" };
  if (/^pause$/i.test(clean)) return { action: "pause" };
  if (/^(resume|unpause)$/i.test(clean)) return { action: "resume" };
  if (/^stop$/i.test(clean)) return { action: "stop" };
  return null;
}

/** A thread keyword at the start of a message: handled before the Mission
 *  hears anything. */
export function threadKeyword(text: string): "aside" | "mute" | "unmute" | null {
  if (/^(!aside\b|\(aside\))/i.test(text)) return "aside";
  if (/^!mute\b/i.test(text)) return "mute";
  if (/^!unmute\b/i.test(text)) return "unmute";
  return null;
}

/** What the system posts when a Mission goes on call in a channel. */
export function introText(input: { mission: string; project: string; url: string | null }): string {
  const name = input.url ? `<${input.url}|${input.mission.replace(/[<>|]/g, "")}>` : input.mission;
  return `:wave: Mission ${name} is on call here for *${input.project}*. Mention @Outrunner with a task: it answers in the thread, and starts Ships (cloud sessions that open pull requests) for work. Replies in its threads reach it without a mention; \`!aside\` keeps one from it, \`!mute\` silences a thread. \`@Outrunner stop\` stops its turn; \`@Outrunner pause\` pauses it here.`;
}

/** Slack's buttons for a question card. Each option's value names the card
 *  and the option; "Other" asks for a reply in the thread. */
export const MISSION_ASK_ACTION = "mission_ask";
export const MISSION_ASK_OTHER = "mission_ask_other";

export function askBlocks(askId: string, question: string, options: readonly string[]): Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: question.slice(0, 2900) } },
    {
      type: "actions",
      block_id: `mission_ask:${askId}`,
      elements: [
        ...options.map((option, i) => ({
          type: "button",
          action_id: `${MISSION_ASK_ACTION}:${i}`,
          text: { type: "plain_text", text: option.slice(0, 75), emoji: true },
          value: `${askId}:${i}`,
        })),
        { type: "button", action_id: MISSION_ASK_OTHER, text: { type: "plain_text", text: "Other" }, value: `${askId}:other` },
      ],
    },
  ];
}

/** The card once answered: the question, and who picked what. */
export function answeredBlocks(question: string, answer: string, by: string): Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: question.slice(0, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `*${answer.replace(/[*<>|]/g, "")}*, picked by ${by}` }] },
  ];
}

/** Why a card's question isn't waiting any more. */
export type CardEnd = "off_call" | "archived";

export const cardEndText = (why: CardEnd): string =>
  why === "archived" ? "No longer waiting: the Mission was archived" : "No longer waiting: the Mission went off call";

/** The card once its Mission can't hear the answer: the question, and why
 *  nothing is waiting on it. No buttons. */
export function closedBlocks(question: string, why: CardEnd): Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: question.slice(0, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: cardEndText(why) }] },
  ];
}

/** A click's value read back: the card and the option. */
export function parseAskValue(value: string): { askId: string; option: number | "other" } | null {
  const match = /^([0-9a-f-]{36}):(\d|other)$/.exec(value);
  if (!match) return null;
  return { askId: match[1], option: match[2] === "other" ? "other" : Number(match[2]) };
}

/** The reactions slack_react may add, by name (or the emoji itself). */
const REACTIONS: Record<string, string> = {
  eyes: "eyes",
  "👀": "eyes",
  white_check_mark: "white_check_mark",
  "✅": "white_check_mark",
  x: "x",
  "❌": "x",
};

export function reactionName(emoji: string): string | null {
  return REACTIONS[emoji.trim().replace(/^:|:$/g, "")] ?? null;
}

/** A Ship's pull request ready, merged or closed, as its thread is told. */
export function pullRequestCard(kind: "opened" | "ready" | "merged" | "closed", pr: PullRequestRef, ship: string): string {
  const link = pullRequestLink(pr);
  const who = ship.replace(/[<>|*]/g, "");
  switch (kind) {
    case "opened":
      return `:arrow_heading_up: Opened: ${link} (Ship ${who})`;
    case "ready":
      return `:white_check_mark: Ready for review: ${link} (Ship ${who})`;
    case "merged":
      return `:rocket: Merged: ${link} (Ship ${who})`;
    case "closed":
      return `:no_entry_sign: Closed without merging: ${link} (Ship ${who})`;
  }
}

/** A limit on Ships reached, as the thread is told. */
export function limitText(refused: "hour" | "day", limit: number): string {
  const ships = `${limit} Ship${limit === 1 ? "" : "s"}`;
  return refused === "hour"
    ? `I've started ${ships} for this channel in the last hour, which is my limit, so I didn't start one for this. Ask again in a while.`
    : `I've started ${ships} for this channel in the last 24 hours, which is my limit, so I didn't start one for this. Ask again later.`;
}

/** Idle pause (docs/missions.md, "Idle pause"): the channel's offer after 2
 *  weeks with no human, and the pause 24 hours after it. */
export const IDLE_OFFER_TEXT = "No one has replied here for 2 weeks. I'll pause in 24 hours unless someone replies. @Outrunner resume any time after.";
export const IDLE_PAUSE_TEXT = "Paused: no one has replied for 2 weeks. @Outrunner resume to continue.";

/** A Mission's Slack channel as its header shows it (GET /api/missions/[id]/slack). */
export type MissionSlackView = {
  binding: {
    teamId: string;
    channelId: string;
    channelName: string | null;
    paused: boolean;
    /** Paused by the idle sweep (no human for 2 weeks), not by a person. */
    idlePaused?: boolean;
    listen: string;
  } | null;
  /** Channels it could go on call in: those Outrunner is in, of the Slack
   *  workspaces the owner has linked into the Mission's org. Unbound only. */
  channels: { teamId: string; teamName: string | null; id: string; name: string }[];
  canManage: boolean;
  /** Why there's nothing to pick, when there isn't. */
  hint: string | null;
};
