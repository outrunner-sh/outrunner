/**
 * What started a run, as its session is told: a pull request event
 * (lib/automations/pull-request.ts), an issue's (lib/automations/github-events.ts),
 * a schedule coming due, or a POST to the automation's webhook
 * (lib/automations/webhook.ts). Kept with the
 * run (automation_runs.context), so a run that failed starts again as it
 * first would have. No I/O.
 */

import { type IssueEvent, issuePrompt, issueTitle } from "@/lib/automations/github-events";
import { atHead, type PullRequestEvent, runPrompt, runTitle } from "@/lib/automations/pull-request";
import type { AutomationTrigger } from "@/lib/automations/rules";
import { isTimeZone, wallTime } from "@/lib/automations/schedule";
import { fillPayload, type WebhookEvent } from "@/lib/automations/webhook";

/** A schedule came due at `scheduledFor` (an ISO instant). */
export type ScheduleEvent = {
  trigger: "schedule";
  scheduledFor: string;
  /** The schedule's zone, and the schedule as the page says it. */
  timezone: string;
  description: string;
  /** A Mission's: earlier times an outage missed, folded into this one. */
  missed?: number;
};

/** A message in a Slack channel a Mission's automation watches. */
export type SlackWatchEvent = {
  trigger: "slack.message";
  teamId: string;
  channelId: string;
  ts: string;
  /** Who said it: a person's Slack id, or an app's bot (and its app id). */
  user: string;
  botId?: string | null;
  appId?: string | null;
  author?: string | null;
  text: string;
  permalink?: string | null;
};

/** A Linear issue delegated to Outrunner, routed to a Mission. */
export type LinearIssueEvent = {
  trigger: "linear.issue";
  installationId: string;
  agentSessionId: string;
  issueId: string;
  identifier?: string | null;
  title: string;
  url?: string | null;
  /** What the delegation asked: its prompt, or the issue's description. */
  prompt: string;
  /** The person who delegated it, linked to Outrunner (null: a rule). */
  requestedBy: string | null;
  from?: string | null;
};

export type RunEvent = PullRequestEvent | IssueEvent | ScheduleEvent | WebhookEvent | SlackWatchEvent | LinearIssueEvent;

/** A Mission's own events: never a session's. */
export function isMissionEvent(event: RunEvent): event is SlackWatchEvent | LinearIssueEvent {
  return event.trigger === "slack.message" || event.trigger === "linear.issue";
}

export function isPullRequestEvent(event: RunEvent): event is PullRequestEvent {
  return event.trigger.startsWith("pull_request.");
}

export function isIssueEvent(event: RunEvent): event is IssueEvent {
  return event.trigger.startsWith("issues.");
}

/** What a debounce window combines triggers on, and a run is about: a pull
 *  request, an issue, the schedule, the webhook. */
export function eventSubject(event: RunEvent): string {
  if (isPullRequestEvent(event)) return `pr:${event.number}`;
  if (isIssueEvent(event)) return `issue:${event.number}`;
  if (event.trigger === "slack.message") return `slack:${event.channelId}:${event.ts}`;
  if (event.trigger === "linear.issue") return `linear:${event.issueId}`;
  return event.trigger;
}

/** Where the run is, beside its event: told to its session. A pull
 *  request's run is told its id, to mark its review with
 *  (lib/automations/checks.ts). */
export type RunPlace = { repoFullName: string; appSlug?: string; runId?: string };

/** `instant` on the zone's clock: "Nov 2, 09:00". */
export function onClock(instant: string, timezone: string): string {
  const w = wallTime(Date.parse(instant), timezone);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][w.month - 1];
  return `${month} ${w.day}, ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** A run's session title. */
export function eventTitle(automationName: string, event: RunEvent): string {
  if (isPullRequestEvent(event)) return runTitle(automationName, event);
  if (isIssueEvent(event)) return issueTitle(automationName, event);
  if (isMissionEvent(event)) {
    const title = event.trigger === "linear.issue" ? `${automationName}: ${event.identifier ?? event.title}` : `${automationName}, Slack message`;
    return title.length > 120 ? `${title.slice(0, 119)}…` : title;
  }
  const title =
    event.trigger === "webhook"
      ? `${automationName}, webhook ${onClock(event.receivedAt, "UTC")} UTC`
      : `${automationName}, ${onClock(event.scheduledFor, event.timezone)}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** The branch its session starts from; the repository's default when none. */
export function eventBaseBranch(event: RunEvent): string | undefined {
  if (isPullRequestEvent(event)) return atHead(event.trigger) ? event.headRef : event.baseRef;
  return undefined;
}

/** What a run's session is told: what started it, where, then the
 *  automation's own prompt. */
export function eventPrompt(automationPrompt: string, event: RunEvent, place: RunPlace): string {
  if (isPullRequestEvent(event)) return runPrompt(automationPrompt, event, place.appSlug, place.runId);
  if (isIssueEvent(event)) return issuePrompt(automationPrompt, event, place.appSlug);
  // A Mission's: never a session's prompt (lib/missions/automation-target.ts).
  if (isMissionEvent(event)) return automationPrompt;
  return [
    event.trigger === "webhook"
      ? `Webhook run: a POST to this automation's URL, ${onClock(event.receivedAt, "UTC")} UTC.`
      : `Scheduled run: ${event.description} (${event.timezone}), due ${onClock(event.scheduledFor, event.timezone)}.`,
    `Repository: ${place.repoFullName}. This session's working tree is its default branch.`,
    "`gh` is signed in as the Outrunner GitHub App for this repository: it reads code, issues and pull requests, and comments on them; it can't push.",
    "",
    event.trigger === "webhook" ? fillPayload(automationPrompt, event.payload) : automationPrompt,
  ].join("\n");
}

const PR_TRIGGERS: readonly AutomationTrigger[] = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "pull_request.merged",
  "pull_request.review_requested",
];

/**
 * A run's kept event (automation_runs.context), read back; null for one that
 * isn't (a run from before runs kept theirs). Only the fields a session is
 * told, each checked: it's the server's own write, but a run started again
 * from it goes as far as GitHub.
 */
export function readRunEvent(value: unknown): RunEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : null);
  if (v.trigger === "webhook") {
    const receivedAt = text("receivedAt");
    if (!receivedAt || Number.isNaN(Date.parse(receivedAt))) return null;
    const payloadHash = text("payloadHash");
    return { trigger: "webhook", receivedAt, payload: v.payload ?? null, ...(payloadHash && { payloadHash }) };
  }
  if (v.trigger === "schedule") {
    const scheduledFor = text("scheduledFor");
    const timezone = text("timezone");
    if (!scheduledFor || Number.isNaN(Date.parse(scheduledFor)) || !isTimeZone(timezone)) return null;
    const missed = typeof v.missed === "number" && Number.isInteger(v.missed) && v.missed > 0 ? v.missed : undefined;
    return { trigger: "schedule", scheduledFor, timezone, description: text("description") ?? "", ...(missed && { missed }) };
  }
  if (v.trigger === "slack.message") {
    const teamId = text("teamId");
    const channelId = text("channelId");
    const ts = text("ts");
    const user = text("user");
    if (!teamId || !channelId || !ts || !user) return null;
    return {
      trigger: "slack.message",
      teamId,
      channelId,
      ts,
      user,
      botId: text("botId"),
      appId: text("appId"),
      author: text("author"),
      text: text("text") ?? "",
      permalink: text("permalink"),
    };
  }
  if (v.trigger === "linear.issue") {
    const installationId = text("installationId");
    const agentSessionId = text("agentSessionId");
    const issueId = text("issueId");
    if (!installationId || !agentSessionId || !issueId) return null;
    return {
      trigger: "linear.issue",
      installationId,
      agentSessionId,
      issueId,
      identifier: text("identifier"),
      title: text("title") ?? "",
      url: text("url"),
      prompt: text("prompt") ?? "",
      requestedBy: text("requestedBy"),
      from: text("from"),
    };
  }
  if (v.trigger === "issues.opened" || v.trigger === "issues.labeled") {
    const installationId = v.installationId;
    const number = v.number;
    const repoFullName = text("repoFullName");
    if (typeof installationId !== "number" || typeof number !== "number" || !repoFullName) return null;
    const label = text("label");
    return {
      installationId,
      trigger: v.trigger,
      repoFullName,
      number,
      title: text("title") ?? "",
      url: text("url") ?? `https://github.com/${repoFullName}/issues/${number}`,
      ...(label ? { label } : {}),
    };
  }
  if (PR_TRIGGERS.includes(v.trigger as AutomationTrigger)) {
    const installationId = v.installationId;
    const number = v.number;
    const repoFullName = text("repoFullName");
    const headSha = text("headSha");
    const headRef = text("headRef");
    const baseRef = text("baseRef");
    if (
      typeof installationId !== "number" ||
      typeof number !== "number" ||
      !repoFullName ||
      !headSha ||
      !/^[0-9a-f]{40}$/.test(headSha) ||
      !headRef ||
      !baseRef
    ) {
      return null;
    }
    return {
      installationId,
      trigger: v.trigger as PullRequestEvent["trigger"],
      repoFullName,
      number,
      title: text("title") ?? "",
      url: text("url") ?? `https://github.com/${repoFullName}/pull/${number}`,
      headSha,
      headRef,
      baseRef,
      ...(text("reviewer") ? { reviewer: text("reviewer") as string } : {}),
    };
  }
  return null;
}
