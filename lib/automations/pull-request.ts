/**
 * A GitHub `pull_request` event, as an automation's trigger: what it is, and
 * what a run started by it is told. No I/O, so the Outrunner GitHub App's
 * webhook (lib/automations/runs.ts) and its tests share it.
 */

import type { AutomationTrigger } from "@/lib/automations/rules";
/** An installation id as GitHub sends it: a positive integer. */
function installationId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A pull request event that may start a run. */
export type PullRequestEvent = {
  installationId: number;
  trigger: AutomationTrigger;
  /** The base repository, `owner/name`, where the pull request is. */
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** Branches, without a remote: the head is in the base repository. */
  headRef: string;
  baseRef: string;
};

/** Why an event starts nothing; null when it may. */
export type PullRequestSkip = "action" | "draft" | "fork" | "bot" | "unreadable";

/**
 * The trigger an action is: a pull request opened, or opened again (reopened,
 * or ready for review after a draft), is reviewed as new; new commits are
 * `pull_request.synchronize`. Every other action starts nothing.
 *
 * An automation runs once per commit of a pull request, whatever the trigger
 * (automation_runs' unique key): reopened at a commit it already ran at, it
 * doesn't run again; the code is the same.
 */
export function triggerFor(action: unknown): AutomationTrigger | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      return "pull_request.opened";
    case "synchronize":
      return "pull_request.synchronize";
    default:
      return null;
  }
}

type Payload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  pull_request?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    draft?: unknown;
    user?: { login?: unknown } | null;
    head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null } | null;
    base?: { ref?: unknown; repo?: { full_name?: unknown } | null } | null;
  } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Bots whose pull requests no automation runs on: dependency bumps. Others
 *  (an agent's, opening real changes) are reviewed like anyone's. */
export const SKIPPED_BOTS = ["dependabot[bot]", "renovate[bot]"] as const;

/**
 * The event, or why it starts nothing. Drafts wait to be ready; a fork's head
 * isn't in the repository's mirror on the box; and dependency bots' pull
 * requests (SKIPPED_BOTS) aren't reviewed, nor are the Outrunner app's own
 * (`appSlug`'s bot), which would review itself.
 */
export function readPullRequestEvent(payload: unknown, appSlug?: string): PullRequestEvent | PullRequestSkip {
  const p = (payload ?? {}) as Payload;
  const trigger = triggerFor(p.action);
  if (!trigger) return "action";
  const pr = p.pull_request;
  const id = installationId(p.installation?.id);
  const repoFullName = text(p.repository?.full_name) ?? text(pr?.base?.repo?.full_name);
  const number = pr?.number;
  const headSha = text(pr?.head?.sha);
  const headRef = text(pr?.head?.ref);
  const baseRef = text(pr?.base?.ref);
  if (
    !pr ||
    id === null ||
    !repoFullName ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !headSha ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !headRef ||
    !baseRef
  ) {
    return "unreadable";
  }
  if (pr.draft === true) return "draft";
  if (text(pr.head?.repo?.full_name)?.toLowerCase() !== repoFullName.toLowerCase()) return "fork";
  const author = text(pr.user?.login)?.toLowerCase();
  const skipped: readonly string[] = appSlug ? [...SKIPPED_BOTS, `${appSlug.toLowerCase()}[bot]`] : SKIPPED_BOTS;
  if (author && skipped.includes(author)) return "bot";
  return {
    installationId: id,
    trigger,
    repoFullName,
    number,
    title: text(pr.title) ?? "",
    url: text(pr.html_url) ?? `https://github.com/${repoFullName}/pull/${number}`,
    headSha,
    headRef,
    baseRef,
  };
}

/** A run's session title: the pull request it's for. */
export function runTitle(automationName: string, event: Pick<PullRequestEvent, "number" | "title">): string {
  const title = `${automationName} #${event.number}${event.title ? `: ${event.title}` : ""}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/**
 * What a run's session is told: the pull request it's for, then the
 * automation's own prompt. Its working tree is the pull request's head; the
 * change to look at is against its base.
 */
export function runPrompt(automationPrompt: string, event: PullRequestEvent, appSlug?: string): string {
  // What it posts is the App's bot's: only that account's comments are its
  // own earlier passes, not another reviewer's (a person's, another app's).
  const self = appSlug ? `${appSlug.toLowerCase()}[bot]` : null;
  return [
    `Pull request: ${event.repoFullName}#${event.number}${event.title ? ` "${event.title}"` : ""}`,
    `URL: ${event.url}`,
    `Base branch: ${event.baseRef}. Head branch: ${event.headRef}, at ${event.headSha}.`,
    `This session's working tree is the head's code. Read the change with \`gh pr diff ${event.number}\` and \`gh pr view ${event.number}\`; \`gh\` is signed in as the Outrunner GitHub App for this repository.`,
    self
      ? `What you post appears as ${self}. Its comments are from earlier passes of the App's automations, this one's included; comments by anyone else (people, other review bots) aren't, so don't call them a previous pass or a re-run, but don't repeat a point they've already made either.`
      : "",
    event.trigger === "pull_request.synchronize"
      ? "The pull request has new commits since it was last looked at: look at it again, and don't repeat what's already been said on it."
      : "",
    "",
    automationPrompt,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
