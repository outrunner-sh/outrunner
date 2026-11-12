/**
 * A Mission's events from its Runners (mission_events): what each kind
 * carries, the key that records each one once, and how a delivery of them
 * reads to the Mission's agent, as `<runner_event>` blocks (the Mission's
 * prompt, lib/missions/prompt.ts, says what to do with each; the session page
 * shows them as cards). A Mission on call in Slack also hears Slack's news
 * (lib/missions/slack-route.ts), with no Ship: `<slack_request>`,
 * `<slack_answer>` and `<slack_channel>` blocks. The parts with no network.
 */

import { ON_CALL_PROMPT } from "@/lib/missions/prompt";
import type { NotificationDraft } from "@/lib/notifications/events";
import type { MissionEventKind } from "@/lib/supabase/database.types";

export type { MissionEventKind };

export type PullRequestRef = { repo: string; number: number; url: string; title: string };

export type MissionEventPayload = {
  /** The Runner's name, as the sidebar shows it. */
  runner?: string;
  /** finished: the Runner's latest response. */
  response?: string | null;
  /** finished: read before its box went to sleep. */
  asleep?: boolean;
  /** ready / needs_attention / merged / closed: the pull request. */
  pr?: PullRequestRef;
  /** ready / needs_attention / archived: why. */
  reason?: string;
  /** slack_request / slack_answer / slack_channel: where in Slack, and what. */
  slack?: SlackEventPayload;
};

/** Slack's news for a Mission on call (docs/missions.md, "On call in Slack"). */
export type SlackEventPayload = {
  /** The bound channel. */
  channel: string;
  /** slack_request / slack_answer: the thread's ts, which the Mission's
   *  slack_* tools name it by. */
  thread?: string;
  /** slack_request: its key, which spawn_runner and slack_react take as
   *  request_id. */
  request?: string;
  /** slack_request: the message's own ts. */
  ts?: string;
  permalink?: string | null;
  /** Who said it, as Slack shows them, and their Slack id. */
  author?: string;
  slackUserId?: string;
  /** Their linked Outrunner account. */
  userId?: string | null;
  /** slack_request: what they said (Slack's markup made Markdown); its
   *  files' names. */
  text?: string;
  files?: string[];
  /** slack_answer: the question, and the answer picked. */
  question?: string;
  answer?: string;
  /** slack_channel: on call there now, or not any more. */
  bound?: boolean;
  /** slack_channel: the channel's name, when Slack said it. */
  channelName?: string | null;
};

/** The kinds that are Slack's, with no Ship. */
export const SLACK_EVENT_KINDS = ["slack_request", "slack_answer", "slack_channel"] as const satisfies readonly MissionEventKind[];

export function isSlackEvent(kind: MissionEventKind): kind is (typeof SLACK_EVENT_KINDS)[number] {
  return (SLACK_EVENT_KINDS as readonly string[]).includes(kind);
}

export type MissionEvent = {
  id: string;
  /** The Ship it's about; null for Slack's kinds. */
  runnerId: string | null;
  kind: MissionEventKind;
  payload: MissionEventPayload;
  createdAt: string;
};

/** The most of a Runner's response a delivery carries; read_runner has all. */
export const RESPONSE_MAX_CHARS = 6000;

function prKey(pr: { repo: string; number: number }): string {
  return `${pr.repo.toLowerCase()}#${pr.number}`;
}

/** Each event's idempotency key: what makes two sightings one event. */
export const eventKey = {
  /** One a watched turn: the watch is opened once a send, at `sentAt`. */
  finished: (runnerId: string, sentAt: string) => `finished:${runnerId}:${sentAt}`,
  /** A Runner that can't go on: once a cause a watch (or a setup). */
  needsAttention: (runnerId: string, cause: string, at: string) => `needs_attention:${runnerId}:${cause}:${at}`,
  /** A pull request's decision, numbered: one a change. */
  decision: (runnerId: string, pr: { repo: string; number: number }, seq: number) => `decision:${runnerId}:${prKey(pr)}:${seq}`,
  ended: (kind: "merged" | "closed", runnerId: string, pr: { repo: string; number: number }) => `${kind}:${runnerId}:${prKey(pr)}`,
  archived: (runnerId: string, at: string) => `archived:${runnerId}:${at}`,
  /** A Slack message, by Slack's own event id: Slack's retries of it are
   *  one request. */
  slackRequest: (eventId: string) => `slack_request:${eventId}`,
  /** A question card's answer: its first, only. */
  slackAnswer: (askId: string) => `slack_answer:${askId}`,
  /** The binding changing: once a change. */
  slackChannel: (missionId: string, bound: boolean, at: string) => `slack_channel:${missionId}:${bound ? "on" : "off"}:${at}`,
};

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");
}

/** Text from outside (a Runner's reply, a pull request's title) as a block's
 *  body: a `runner_event` tag in it is made harmless, so it can't close the
 *  block and pass off one of its own as an event, to the Mission or the
 *  page. */
function inert(text: string): string {
  return text.replace(/<(\/?)(runner|slack)_(event|request|answer|channel)/gi, "<$1$2-$3");
}

function prLine(pr: PullRequestRef | undefined): string {
  return pr ? `Pull request: ${pr.repo}#${pr.number} "${pr.title}" ${pr.url}` : "";
}

function body(event: MissionEvent): string {
  const p = event.payload;
  switch (event.kind) {
    case "finished": {
      const response = p.response?.trim();
      if (!response) return p.asleep ? "Its turn ended; its box went to sleep before its reply could be read. read_runner wakes it." : "Its turn ended without a reply.";
      const cut = response.length > RESPONSE_MAX_CHARS ? `${response.slice(0, RESPONSE_MAX_CHARS)}\n[cut: read_runner has the rest]` : response;
      return `Its turn ended. Its latest response:\n\n${cut}`;
    }
    case "ready":
      return [prLine(p.pr), `Ready: ${p.reason ?? "checks pass"}.`].filter(Boolean).join("\n");
    case "needs_attention":
      return [prLine(p.pr), `Needs attention: ${p.reason ?? "unknown cause"}.`].filter(Boolean).join("\n");
    case "merged":
      return `${prLine(p.pr)}\nMerged.`;
    case "closed":
      return `${prLine(p.pr)}\nClosed without merging.`;
    case "archived":
      return `Archived: ${p.reason ?? "its work is done"}. Messaging it restores it.`;
    case "slack_request": {
      const s = p.slack;
      const files = s?.files?.length ? `\nFiles: ${s.files.join(", ")}` : "";
      return `${s?.text?.trim() || "(no text)"}${files}`;
    }
    case "slack_answer":
      return `Your question: ${p.slack?.question ?? ""}\nAnswer: ${p.slack?.answer ?? ""}`;
    case "slack_channel":
      return p.slack?.bound
        ? `You are now on call in the Slack channel ${channelLabel(p.slack)}.\n\n${ON_CALL_PROMPT}`
        : `You are no longer on call in the Slack channel ${channelLabel(p.slack)}. Its threads don't reach you any more, and your slack_* tools are off. Don't post in Slack.`;
  }
}

function channelLabel(slack: SlackEventPayload | undefined): string {
  if (!slack) return "(unknown)";
  return slack.channelName ? `#${slack.channelName} (${slack.channel})` : slack.channel;
}

/** One of Slack's events as the Mission reads it: its own tag, naming the
 *  thread its slack_* tools take. */
function formatSlackEvent(event: MissionEvent): string {
  const s = event.payload.slack;
  const attrs = [
    s?.thread && `thread="${attr(s.thread)}"`,
    s?.request && `request_id="${attr(s.request)}"`,
    s?.author && `from="${attr(s.author)}"`,
    s?.permalink && `permalink="${attr(s.permalink)}"`,
    `at="${event.createdAt}"`,
  ].filter(Boolean);
  return `<${event.kind} ${attrs.join(" ")}>\n${inert(body(event))}\n</${event.kind}>`;
}

/** One event as the Mission reads it. */
export function formatEvent(event: MissionEvent): string {
  if (isSlackEvent(event.kind)) return formatSlackEvent(event);
  const name = event.payload.runner ? ` runner="${attr(event.payload.runner)}"` : "";
  return `<runner_event kind="${event.kind}" runner_id="${event.runnerId}"${name} at="${event.createdAt}">\n${inert(body(event))}\n</runner_event>`;
}

/** A delivery: its events, oldest first, in one message. */
export function formatDelivery(events: readonly MissionEvent[]): string {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sorted.map(formatEvent).join("\n\n");
}

/** The `<runner_event>` blocks in a message (and Slack's), for the session
 *  page's cards: what's around them is the message's own text. A Slack block
 *  has no Ship (`runnerId` is empty), and says who and where instead. */
export type ParsedRunnerEvent = {
  kind: MissionEventKind;
  runnerId: string;
  runner: string | null;
  at: string | null;
  body: string;
  /** Slack's kinds: who said it, and the link to it. */
  from?: string | null;
  permalink?: string | null;
};

const BLOCK = /<(runner_event|slack_request|slack_answer|slack_channel)\s+([^>]*)>\n?([\s\S]*?)\n?<\/\1>/g;
const ATTR = /(\w+)="([^"]*)"/g;

function unattr(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function parseRunnerEvents(text: string): { events: ParsedRunnerEvent[]; rest: string } {
  const events: ParsedRunnerEvent[] = [];
  const rest = text.replace(BLOCK, (_, tag: string, attrs: string, inner: string) => {
    const found: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(ATTR)) found[k] = unattr(v);
    if (tag !== "runner_event") {
      const kind = tag as MissionEventKind;
      // The Mission's own instructions aren't news to show.
      const shown = kind === "slack_channel" ? inner.split("\n")[0] : inner;
      events.push({ kind, runnerId: "", runner: null, at: found.at ?? null, body: shown.trim(), from: found.from ?? null, permalink: found.permalink ?? null });
      return "";
    }
    const kind = found.kind as MissionEventKind;
    if (["finished", "ready", "needs_attention", "merged", "closed", "archived"].includes(kind) && found.runner_id) {
      events.push({ kind, runnerId: found.runner_id, runner: found.runner ?? null, at: found.at ?? null, body: inner.trim() });
    }
    return "";
  });
  return { events, rest: rest.replace(/\n{3,}/g, "\n\n").trim() };
}

/** A Runner's pull request ready, as the notification its Mission's owner
 *  gets (lib/notifications): on the Mission, once a decision. */
export function readyNotification(input: {
  ownerId: string;
  missionId: string;
  missionTitle: string;
  runnerName: string;
  runnerId: string;
  pr: PullRequestRef;
  seq: number;
}): NotificationDraft {
  return {
    userId: input.ownerId,
    workspaceId: input.missionId,
    kind: "pr_ready",
    eventKey: `${input.runnerId}:${input.pr.repo.toLowerCase()}#${input.pr.number}:${input.seq}`,
    title: input.missionTitle,
    body: `#${input.pr.number} ready to review: ${input.pr.title} (${input.runnerName})`,
  };
}

/** A pr_ready notification's body read back (readyNotification writes it):
 *  its number, title and Runner, for the toast; null for any other. */
export function parseReadyBody(body: string): { number: number; title: string; runner: string | null } | null {
  const match = /^#(\d+) ready to review: (.*?)(?: \(([^()]*)\))?$/.exec(body);
  return match ? { number: Number(match[1]), title: match[2], runner: match[3] ?? null } : null;
}
