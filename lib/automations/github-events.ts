/**
 * The GitHub events beside a pull request's opening and commits that start
 * automations: an issue opened or labeled, and a pull request closed, merged
 * or given a review request (lib/automations/pull-request.ts reads those).
 * What each is, which automations it's for, the key that makes its run once,
 * and what the run's session is told. No I/O.
 */

import { type PullRequestEvent, SKIPPED_BOTS } from "@/lib/automations/pull-request";
import type { IssueTrigger } from "@/lib/automations/rules";

/** An issue event that may start a run. */
export type IssueEvent = {
  installationId: number;
  trigger: IssueTrigger;
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  /** The label added (`issues.labeled`). */
  label?: string;
};

export type IssueSkip = "action" | "bot" | "unreadable";

type IssuePayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  label?: { name?: unknown } | null;
  sender?: { login?: unknown } | null;
  issue?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    pull_request?: unknown;
    user?: { login?: unknown } | null;
  } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * An `issues` event, or why it starts nothing: only opened and labeled do;
 * dependency bots' issues, and the Outrunner App's own (`appSlug`'s bot,
 * which an automation's run may have opened: it would start itself), don't,
 * nor does what they did to anyone's (a run labeling an issue).
 */
export function readIssueEvent(payload: unknown, appSlug?: string): IssueEvent | IssueSkip {
  const p = (payload ?? {}) as IssuePayload;
  const trigger = p.action === "opened" ? "issues.opened" : p.action === "labeled" ? "issues.labeled" : null;
  if (!trigger) return "action";
  const id = p.installation?.id;
  const repoFullName = text(p.repository?.full_name);
  const number = p.issue?.number;
  const label = text(p.label?.name);
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !repoFullName ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    // A pull request's labels come as its own events.
    p.issue?.pull_request ||
    (trigger === "issues.labeled" && !label)
  ) {
    return "unreadable";
  }
  // Who opened it, and who did this to it (a label is added by whoever adds
  // it, which may be a run's session, as the App, on someone's issue).
  const author = text(p.issue?.user?.login)?.toLowerCase();
  const sender = text(p.sender?.login)?.toLowerCase();
  const skipped: readonly string[] = appSlug ? [...SKIPPED_BOTS, `${appSlug.toLowerCase()}[bot]`] : SKIPPED_BOTS;
  if ((author && skipped.includes(author)) || (sender && skipped.includes(sender))) return "bot";
  return {
    installationId: id,
    trigger,
    repoFullName,
    number,
    title: text(p.issue?.title) ?? "",
    url: text(p.issue?.html_url) ?? `https://github.com/${repoFullName}/issues/${number}`,
    ...(trigger === "issues.labeled" && label ? { label } : {}),
  };
}

/** Whether an automation's filters take the event: a review request of one
 *  of its `reviewers`, a label among its `labels` (none: any). */
export function filtersTake(
  automation: { reviewers: readonly string[]; labels: readonly string[] },
  event: PullRequestEvent | IssueEvent,
): boolean {
  if (event.trigger === "pull_request.review_requested") {
    const reviewer = "reviewer" in event ? event.reviewer?.toLowerCase() : undefined;
    return Boolean(reviewer) && automation.reviewers.some((r) => r.toLowerCase() === reviewer);
  }
  if (event.trigger === "issues.labeled") {
    const label = "label" in event ? event.label?.toLowerCase() : undefined;
    return automation.labels.length === 0 || automation.labels.some((l) => l.toLowerCase() === label);
  }
  return true;
}

/**
 * The key that makes an event's run once. A pull request's opening and new
 * commits are its commit's, whichever comes first (as ever); its closing,
 * its commit's too, and merged, once. A review request, and a label, are the
 * delivery's (`X-GitHub-Delivery`, the same on a redelivery): requesting a
 * review again, or a label again, is meant to run it again. Without one, the
 * request's own.
 */
export function eventDedupeKey(event: PullRequestEvent | IssueEvent, delivery: string | null): string {
  const byDelivery = delivery && /^[A-Za-z0-9-]{1,100}$/.test(delivery) ? `gh:${delivery}` : null;
  switch (event.trigger) {
    case "pull_request.opened":
    case "pull_request.synchronize":
      return `pr:${event.number}:${event.headSha}`;
    case "pull_request.closed":
      return `pr:${event.number}:closed:${event.headSha}`;
    case "pull_request.merged":
      return `pr:${event.number}:merged`;
    case "pull_request.review_requested":
      return byDelivery ?? `pr:${event.number}:review:${event.reviewer ?? ""}:${event.headSha}`;
    case "issues.opened":
      return `issue:${event.number}:opened`;
    case "issues.labeled":
      return byDelivery ?? `issue:${event.number}:labeled:${event.label ?? ""}`;
  }
}

/** A run's session title for an issue. */
export function issueTitle(automationName: string, event: Pick<IssueEvent, "number" | "title">): string {
  const title = `${automationName} #${event.number}${event.title ? `: ${event.title}` : ""}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** What an issue's run's session is told: the issue, what happened to it,
 *  then the automation's own prompt. */
export function issuePrompt(automationPrompt: string, event: IssueEvent, appSlug?: string): string {
  const self = appSlug ? `${appSlug.toLowerCase()}[bot]` : null;
  return [
    `Issue: ${event.repoFullName}#${event.number}${event.title ? ` "${event.title}"` : ""}`,
    `URL: ${event.url}`,
    event.trigger === "issues.labeled" ? `It was just labeled "${event.label}".` : "It was just opened.",
    `Read it with \`gh issue view ${event.number} --comments\`; \`gh\` is signed in as the Outrunner GitHub App for this repository: it reads code, issues and pull requests, and comments on them; it can't push. This session's working tree is the repository's default branch.`,
    self ? `What you post appears as ${self}.` : "",
    "",
    automationPrompt,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
