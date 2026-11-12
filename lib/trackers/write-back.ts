/**
 * What goes back to a tracker's issue besides a delegated session's own replies:
 *
 *   decline        one comment. Accepting changes nothing there.
 *   session        a session started from the issue's item here, where no one
 *                  delegated it: one comment, naming who and linking it
 *   PR opened      its link: on the agent session when delegated, attached to the
 *                  issue when not (Jira has only a remote link, either way).
 *                  Delegated, the issue also moves to the team's In Review, if it
 *                  has one.
 *   PR merged      the item is done, if it's still open. Delegated, the issue also
 *                  moves to the team's Done, if it has one, and only from the states
 *                  a session put it in: a person's own move since stands.
 *   PR closed      a note on the item, and nothing back.
 *
 * All of it after the fact, best effort: the change here already happened.
 */

import type { TrackerScope } from "@/lib/db/trackers";
import type { TrackerNote } from "@/lib/db/work-items";
import { doneTarget } from "@/lib/trackers/rules";
import { isOpen, type WorkItem } from "@/lib/triage/work-items";

/** An item following a tracker's issue, and the install it's through. */
export type FollowingItem = { orgId: string; item: WorkItem; installationId: string; issueId: string };

/** An issue a session was delegated. `agentSessionId` is Linear's; Jira's is the issue. */
export type DelegatedRow = { agentSessionId: string; issueId: string; stage: string };

export type PullRequestChange = { workspaceId: string; projectId: string; to: string; from: string | null; number: number };

export type WriteBackDeps = {
  itemById(itemId: string): Promise<FollowingItem | null>;
  itemsOfSession(workspaceId: string): Promise<FollowingItem[]>;
  rowsOfSession(workspaceId: string): Promise<DelegatedRow[]>;
  /** By repository: a session of several can have the same number in two. */
  pullRequestUrl(workspaceId: string, projectId: string, number: number): Promise<string | null>;
  comment(installationId: string, issueId: string, body: string): Promise<void>;
  attach(installationId: string, issueId: string, url: string, title: string): Promise<void>;
  addUrl(installationId: string, agentSessionId: string, url: { label: string; url: string }): Promise<void>;
  setIssueState(installationId: string, issueId: string, stateId: string): Promise<void>;
  standing(installationId: string, issueId: string): Promise<{ teamId: string; stateId: string | null; stateType: string | null } | null>;
  scopeForTeam(installationId: string, teamId: string): Promise<TrackerScope | null>;
  close(orgId: string, item: WorkItem, close: { status: "done" }): Promise<void>;
  addNote(orgId: string, itemId: string, note: TrackerNote): Promise<void>;
  sessionUrl(workspaceId: string): string;
};

/** Whether this org is still connected to the issue's team: an item stays after that, but
 *  what it does isn't for the tracker to hear, on someone else's token or none. */
async function stillConnected(following: FollowingItem, deps: WriteBackDeps): Promise<boolean> {
  const standing = await deps.standing(following.installationId, following.issueId);
  if (!standing) return false;
  return (await deps.scopeForTeam(following.installationId, standing.teamId))?.orgId === following.orgId;
}

/** Declined here: one comment there. Outrunner's decision, so the issue stays as it is. */
export async function declinedHere(itemId: string, deps: WriteBackDeps): Promise<void> {
  const following = await deps.itemById(itemId);
  if (!following || !(await stillConnected(following, deps))) return;
  await deps.comment(following.installationId, following.issueId, "Declined in Outrunner's Triage.");
}

/** A session started from the item here, not delegated: one comment. No state change,
 *  as a person still owns the issue. */
export async function sessionStartedHere(orgId: string, itemId: string, startedBy: string, workspaceId: string, deps: WriteBackDeps): Promise<void> {
  const following = await deps.itemById(itemId);
  // Another org's item is no item: its token isn't this org's to comment with.
  if (!following || following.orgId !== orgId || !(await stillConnected(following, deps))) return;
  await deps.comment(following.installationId, following.issueId, `Session started by ${startedBy}: [open it in Outrunner](${deps.sessionUrl(workspaceId)})`);
}

async function moveToInReview(following: FollowingItem, deps: WriteBackDeps): Promise<void> {
  const standing = await deps.standing(following.installationId, following.issueId);
  if (!standing || ["completed", "canceled", "duplicate"].includes(standing.stateType ?? "")) return;
  const scope = await deps.scopeForTeam(following.installationId, standing.teamId);
  // A team may have no In Review state: then there's nothing to move it to.
  const state = scope?.stateMap?.inReview;
  if (state) await deps.setIssueState(following.installationId, following.issueId, state);
}

async function moveToDone(following: FollowingItem, deps: WriteBackDeps): Promise<void> {
  const standing = await deps.standing(following.installationId, following.issueId);
  if (!standing) return;
  const scope = await deps.scopeForTeam(following.installationId, standing.teamId);
  // Not this org's team any more: nothing more goes there from here.
  if (scope?.orgId !== following.orgId) return;
  const state = doneTarget(scope.stateMap, standing);
  if (state) await deps.setIssueState(following.installationId, following.issueId, state);
}

async function oneChange(change: PullRequestChange, following: FollowingItem, rows: readonly DelegatedRow[], deps: WriteBackDeps): Promise<void> {
  // Stopped or un-delegated, it isn't: nothing moves the issue, and its link goes on the
  // issue, as for a session no one delegated.
  const delegated = rows.find((row) => row.issueId === following.issueId && row.stage === "working");
  if (change.to === "open") {
    if (!(await stillConnected(following, deps))) return;
    const url = await deps.pullRequestUrl(change.workspaceId, change.projectId, change.number);
    if (url) {
      const label = `PR #${change.number}`;
      if (delegated) await deps.addUrl(following.installationId, delegated.agentSessionId, { label, url });
      else await deps.attach(following.installationId, following.issueId, url, label);
    }
    if (delegated) await moveToInReview(following, deps);
    return;
  }
  if (change.to === "merged") {
    if (isOpen(following.item.status)) await deps.close(following.orgId, following.item, { status: "done" });
    if (delegated) await moveToDone(following, deps);
    return;
  }
  if (change.to === "closed") {
    await deps.addNote(following.orgId, following.item.id, {
      authorId: null,
      body: `PR #${change.number} was closed without merging.`,
      source: following.item.source,
      sourceUrl: null,
      author: "Outrunner",
      sourceRef: `pr:${change.workspaceId}:${change.number}:closed`,
    });
  }
}

/** Sessions' pull requests opened, merged or closed. One failing doesn't stop the rest. */
export async function pullRequestsChanged(changes: readonly PullRequestChange[], deps: WriteBackDeps): Promise<void> {
  for (const change of changes) {
    try {
      const [items, rows] = await Promise.all([deps.itemsOfSession(change.workspaceId), deps.rowsOfSession(change.workspaceId)]);
      for (const following of items) await oneChange(change, following, rows, deps);
    } catch (error) {
      console.error(`Trackers: couldn't pass on PR #${change.number} of ${change.workspaceId}`, error);
    }
  }
}
