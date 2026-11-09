/**
 * An issue's key (ENG-123), which a branch and a pull request carry, so the tracker's own
 * GitHub integration links them, and moves the issue when the PR merges.
 *
 * The session's branch is named here, by the server, as it's made: pull requests find their
 * sessions by branch, so an agent renaming its own would lose the link, and its standing
 * instructions tell it not to. It reads as what it's for, with no id on the end: a number
 * only when the name is really taken (lib/session/issue-branch.ts).
 */

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
 * Insert on a server-chosen name, and if another took it meanwhile, once more on the next free
 * one, or none (a generated one). Anything else that fails, or a second clash, is the caller's.
 */
export async function withFreeBranch<T>(
  name: string | null,
  insert: (branch: string | null) => Promise<T>,
  next: () => Promise<string | null>,
  isTaken: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await insert(name);
  } catch (error) {
    if (!name || !isTaken(error)) throw error;
    return insert(await next());
  }
}

/** How the agent is told to keep the key, should it ever name a branch itself. */
export function branchHint(source: TrackerIssue["source"], key: string): string {
  return `Keep ${key} in any branch you name, e.g. \`fix/${source === "jira" ? key.toUpperCase() : key.toLowerCase()}-what-it-does\`.`;
}
