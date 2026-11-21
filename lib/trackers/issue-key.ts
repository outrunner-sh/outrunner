/**
 * An issue's key (ENG-123), which a branch and a pull request carry, so the tracker's own
 * GitHub integration links them, and moves the issue when the PR merges.
 *
 * The session's branch is named here, by the server, as it's made: pull requests find their
 * sessions by branch, so an agent renaming its own would lose the link, and its standing
 * instructions tell it not to. It reads as what it's for, with no id on the end: a number
 * only when the name is really taken (lib/session/issue-branch.ts).
 */

import { firstFreeBranch } from "@/lib/session/branch-name";
import type { WorkItemSource } from "@/lib/triage/work-items";

export type TrackerIssue = { source: Extract<WorkItemSource, "linear" | "jira">; key: string };

const KEY_IN_URL = /\/(?:issue|browse)\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]|$)/;

/** The key in an issue's link: Linear's /issue/ENG-1/… and Jira's /browse/ENG-1. */
export function issueKeyOfUrl(url: string | null | undefined): string | null {
  return url?.match(KEY_IN_URL)?.[1] ?? null;
}

/** An item's issue, if it follows one whose key is known. */
export function trackerIssueOf(item: { source: string; sourceUrl: string | null }): TrackerIssue | null {
  if (item.source !== "linear" && item.source !== "jira") return null;
  const key = issueKeyOfUrl(item.sourceUrl);
  return key ? { source: item.source, key } : null;
}

/**
 * A session's branch, as it reads to someone looking at it: `eng-123-checkout-breaks-on-safari`
 * for Linear. Jira's integration wants a key in its own uppercase to link it, so
 * `ENG-123-checkout-breaks-on-safari` there.
 */
export function issueBranch(source: TrackerIssue["source"], key: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return [source === "jira" ? key.toUpperCase() : key.toLowerCase(), slug].filter(Boolean).join("-");
}

/**
 * The issue's name if it's free of the project's sessions and of GitHub; otherwise `-2`, `-3`…
 * (lib/session/branch-name.ts firstFreeBranch, as a generated branch is checked). A name an old
 * session or a person already has is never reused, so its push and its pull request stay its
 * own. If GitHub can't be asked, the project's sessions alone decide.
 */
export async function freeIssueBranchOf(
  base: string,
  sessionBranches: readonly string[],
  knownOnGitHub: ((branch: string) => Promise<boolean>) | null,
): Promise<string> {
  if (!knownOnGitHub) return nextFreeBranch(base, sessionBranches);
  const held = new Set(sessionBranches.map((name) => name.toLowerCase()));
  try {
    const free = await firstFreeBranch(base, async (branch) => held.has(branch.toLowerCase()) || (await knownOnGitHub(branch)));
    if (free) return free;
  } catch (error) {
    console.error(`Couldn't ask GitHub which ${base} branches are taken`, error);
  }
  return nextFreeBranch(base, sessionBranches);
}

/**
 * The issue branch a new session tries first, or null for none: none when a branch was asked
 * for; else the tracker's issue it was started on; else the Triage item's it was started from.
 * Never worth failing a session over, so anything that throws is none.
 */
export async function issueBranchFor(
  input: { requestedBranch: string; issue: TrackerIssue | null; workItemId: string | null; title: string },
  deps: { forIssue(issue: TrackerIssue, title: string): Promise<string>; forItem(workItemId: string): Promise<string | null> },
): Promise<string | null> {
  if (input.requestedBranch) return null;
  try {
    if (input.issue) return await deps.forIssue(input.issue, input.title);
    if (input.workItemId) return await deps.forItem(input.workItemId);
  } catch (error) {
    console.warn("Couldn't name a session's branch for its issue", error);
  }
  return null;
}

/** The name itself if it's free; otherwise `-2`, `-3`… Git's names are case-sensitive, but a
 *  checkout on a Mac's disk isn't, so taken is taken in any case. */
export function nextFreeBranch(base: string, taken: readonly string[]): string {
  const held = new Set(taken.map((name) => name.toLowerCase()));
  if (!held.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!held.has(next.toLowerCase())) return next;
  }
}

/**
 * The branch a new session on a tracker's issue tries next (lib/session/
 * generated-branch.ts insertOnBranch's `generate`): the issue's name first,
 * after a lost race the issue's next free one, and a generated one when
 * there's none or that's lost too. Each issue name it hands out goes into
 * `issueNamed`, so the caller knows which branch keeps the key.
 */
export async function issueFirstBranch(input: {
  first: string | null;
  lost: ReadonlySet<string>;
  next(): Promise<string | null>;
  generated(): Promise<string>;
  issueNamed: Set<string>;
}): Promise<string> {
  if (input.first) {
    const name = input.lost.size === 0 ? input.first : await input.next();
    if (name && !input.lost.has(name)) {
      input.issueNamed.add(name);
      return name;
    }
  }
  return input.generated();
}

/** How the agent is told to keep the key, should it ever name a branch itself. */
export function branchHint(source: TrackerIssue["source"], key: string): string {
  return `Keep ${key} in any branch you name, e.g. \`fix/${source === "jira" ? key.toUpperCase() : key.toLowerCase()}-what-it-does\`.`;
}
