/**
 * A GitHub `pull_request` event, as an automation's trigger: what it is, and
 * what a run started by it is told. No I/O, so the Outrunner GitHub App's
 * webhook (lib/automations/runs.ts) and its tests share it.
 */

import { runMarker } from "@/lib/automations/checks";
import type { PullRequestTrigger } from "@/lib/automations/rules";
import { repositoryIdOf } from "@/lib/db/installation-projects";
/** An installation id as GitHub sends it: a positive integer. */
function installationId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A pull request event that may start a run. */
export type PullRequestEvent = {
  installationId: number;
  trigger: PullRequestTrigger;
  /** The base repository, `owner/name`, where the pull request is. */
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** Branches, without a remote: the head is in the base repository. */
  headRef: string;
  baseRef: string;
  /** Whose review was requested (`pull_request.review_requested`): a login,
   *  or a team as `org/slug`. */
  reviewer?: string;
  /** Requested by the Outrunner App's bot: an automation's run. */
  byApp?: true;
};

/** Why an event starts nothing; null when it may. */
export type PullRequestSkip = "action" | "draft" | "fork" | "bot" | "unreadable";

/**
 * The trigger an action is: a pull request opened, or opened again (reopened,
 * or ready for review after a draft), is reviewed as new; new commits are
 * `pull_request.synchronize`; closed is merged or not (`merged`, from the
 * pull request); and a review requested. Every other action starts nothing.
 *
 * An automation runs once per commit of a pull request, whichever of opened
 * and new commits (automation_runs' key): reopened at a commit it already ran
 * at, it doesn't run again; the code is the same.
 */
export function triggerFor(action: unknown, merged?: unknown): PullRequestTrigger | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      return "pull_request.opened";
    case "synchronize":
      return "pull_request.synchronize";
    case "closed":
      return merged === true ? "pull_request.merged" : "pull_request.closed";
    case "review_requested":
      return "pull_request.review_requested";
    default:
      return null;
  }
}

/** Whether a trigger is the pull request's code to look at, its head: its
 *  session starts there. Closed and merged start from its base. */
export function atHead(trigger: PullRequestTrigger): boolean {
  return trigger !== "pull_request.closed" && trigger !== "pull_request.merged";
}

type Payload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  requested_reviewer?: { login?: unknown } | null;
  sender?: { login?: unknown } | null;
  requested_team?: { slug?: unknown } | null;
  pull_request?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    draft?: unknown;
    merged?: unknown;
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
 * isn't in the repository's mirror on the box (closed or merged, the run
 * starts from the base, so a fork's is run); and dependency bots' pull
 * requests (SKIPPED_BOTS) aren't reviewed, nor are the Outrunner app's own
 * (`appSlug`'s bot), which would review itself.
 */
export function readPullRequestEvent(payload: unknown, appSlug?: string): PullRequestEvent | PullRequestSkip {
  const p = (payload ?? {}) as Payload;
  const trigger = triggerFor(p.action, p.pull_request?.merged);
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
  if (atHead(trigger) && text(pr.head?.repo?.full_name)?.toLowerCase() !== repoFullName.toLowerCase()) return "fork";
  const author = text(pr.user?.login)?.toLowerCase();
  const skipped: readonly string[] = appSlug ? [...SKIPPED_BOTS, `${appSlug.toLowerCase()}[bot]`] : SKIPPED_BOTS;
  if (author && skipped.includes(author)) return "bot";
  // A review a run's session requested, as the App: it may start another
  // automation, never the one that just ran on it (byAppSkips).
  const sender = text(p.sender?.login)?.toLowerCase();
  const byApp = Boolean(appSlug && trigger === "pull_request.review_requested" && sender === `${appSlug.toLowerCase()}[bot]`);
  // A team's as `org/slug`: the repository's owner is the team's org.
  const team = text(p.requested_team?.slug);
  const reviewer = text(p.requested_reviewer?.login) ?? (team ? `${repoFullName.split("/")[0]}/${team}` : null);
  if (trigger === "pull_request.review_requested" && !reviewer) return "unreadable";
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
    ...(trigger === "pull_request.review_requested" && reviewer ? { reviewer } : {}),
    ...(byApp ? { byApp: true as const } : {}),
  };
}

/** A pull request closed or merged: its review sessions are done with.
 *  `repoId` is GitHub's id of the repository, what its projects match by. */
export type ClosedPullRequest = { installationId: number; repoId: number; repoFullName: string; number: number };

/** The pull request a `closed` event is for; null for any other event, or
 *  one that can't be read (a repository id among it). */
export function readClosedPullRequest(payload: unknown): ClosedPullRequest | null {
  const p = (payload ?? {}) as Payload;
  if (p.action !== "closed") return null;
  const id = installationId(p.installation?.id);
  const repoFullName = text(p.repository?.full_name) ?? text(p.pull_request?.base?.repo?.full_name);
  const number = p.pull_request?.number;
  const repoId = repositoryIdOf(payload);
  if (id === null || repoId === null || !repoFullName || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { installationId: id, repoId, repoFullName, number };
}

/** A run's session title: the pull request it's for. */
export function runTitle(automationName: string, event: Pick<PullRequestEvent, "number" | "title">): string {
  const title = `${automationName} #${event.number}${event.title ? `: ${event.title}` : ""}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** What happened to the pull request, as its session is told, beside its
 *  head (opened, new commits). */
function whatHappened(event: PullRequestEvent): string {
  switch (event.trigger) {
    case "pull_request.closed":
      return `It was closed without being merged. This session's working tree is its base branch, ${event.baseRef}. Read what it changed with \`gh pr diff ${event.number}\` and \`gh pr view ${event.number}\`; \`gh\` is signed in as the Outrunner GitHub App for this repository.`;
    case "pull_request.merged":
      return `It was merged into ${event.baseRef}. This session's working tree is ${event.baseRef}, with the merge. Read what it changed with \`gh pr diff ${event.number}\` and \`gh pr view ${event.number}\`; \`gh\` is signed in as the Outrunner GitHub App for this repository.`;
    default:
      return `This session's working tree is the head's code. Read the change with \`gh pr diff ${event.number}\` and \`gh pr view ${event.number}\`; \`gh\` is signed in as the Outrunner GitHub App for this repository.`;
  }
}

/**
 * What a run's session is told: the pull request it's for, what happened to
 * it, then the automation's own prompt. Opened or given new commits, its
 * working tree is the pull request's head, the change to look at against its
 * base; closed or merged, its base.
 */
export function runPrompt(automationPrompt: string, event: PullRequestEvent, appSlug?: string, runId?: string): string {
  // What it posts is the App's bot's: only that account's comments are its
  // own earlier passes, not another reviewer's (a person's, another app's).
  const self = appSlug ? `${appSlug.toLowerCase()}[bot]` : null;
  return [
    `Pull request: ${event.repoFullName}#${event.number}${event.title ? ` "${event.title}"` : ""}`,
    `URL: ${event.url}`,
    `Base branch: ${event.baseRef}. Head branch: ${event.headRef}, at ${event.headSha}.`,
    whatHappened(event),
    self
      ? `What you post appears as ${self}. Its comments are from earlier passes of the App's automations, this one's included; comments by anyone else (people, other review bots) aren't, so don't call them a previous pass or a re-run, but don't repeat a point they've already made either.`
      : "",
    runId
      ? `Post your top-level summary as a comment on the pull request's conversation (\`gh pr comment\`), not as a review's body, and end it with this line, exactly as it is: ${runMarker(runId)} (it's hidden on GitHub, and tells Outrunner your review is in).`
      : "",
    // Automations keep the prompt their template had when they were made, so
    // this reaches the ones made before the Code Review template said it: a
    // session that once posted `-f body=@file` left the path as the comment.
    // TODO: Remove this backstop once the existing Code Review automations
    // have been re-created from the updated template.
    "To post a comment's body from a file, pass it with `gh api -F body=@file` (or `--input` a JSON file, or `gh pr comment --body-file`), never `-f body=@file`, which posts the text \"@file\" itself. Read what you posted back, and fix a comment whose body isn't what you meant.",
    event.trigger === "pull_request.synchronize"
      ? "The pull request has new commits since it was last looked at: look at it again, and don't repeat what's already been said on it."
      : "",
    event.trigger === "pull_request.review_requested" && event.reviewer
      ? `A review of it was just requested of ${event.reviewer}.`
      : "",
    "",
    automationPrompt,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
