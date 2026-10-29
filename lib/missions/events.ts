/**
 * A Mission's events from its Runners (mission_events): what each kind
 * carries, the key that records each one once, and how a delivery of them
 * reads to the Mission's agent, as `<runner_event>` blocks (the Mission's
 * prompt, lib/missions/prompt.ts, says what to do with each; the session page
 * shows them as cards). The parts with no network.
 */

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
};

export type MissionEvent = {
  id: string;
  runnerId: string;
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
};

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");
}

/** Text from outside (a Runner's reply, a pull request's title) as a block's
 *  body: a `runner_event` tag in it is made harmless, so it can't close the
 *  block and pass off one of its own as an event, to the Mission or the
 *  page. */
function inert(text: string): string {
  return text.replace(/<(\/?)runner_event/gi, "<$1runner-event");
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
  }
}

/** One event as the Mission reads it. */
export function formatEvent(event: MissionEvent): string {
  const name = event.payload.runner ? ` runner="${attr(event.payload.runner)}"` : "";
  return `<runner_event kind="${event.kind}" runner_id="${event.runnerId}"${name} at="${event.createdAt}">\n${inert(body(event))}\n</runner_event>`;
}

/** A delivery: its events, oldest first, in one message. */
export function formatDelivery(events: readonly MissionEvent[]): string {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sorted.map(formatEvent).join("\n\n");
}

/** The `<runner_event>` blocks in a message, for the session page's cards:
 *  what's around them is the message's own text. */
export type ParsedRunnerEvent = { kind: MissionEventKind; runnerId: string; runner: string | null; at: string | null; body: string };

const BLOCK = /<runner_event\s+([^>]*)>\n?([\s\S]*?)\n?<\/runner_event>/g;
const ATTR = /(\w+)="([^"]*)"/g;

function unattr(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function parseRunnerEvents(text: string): { events: ParsedRunnerEvent[]; rest: string } {
  const events: ParsedRunnerEvent[] = [];
  const rest = text.replace(BLOCK, (_, attrs: string, inner: string) => {
    const found: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(ATTR)) found[k] = unattr(v);
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
